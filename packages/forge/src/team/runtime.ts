export * as TeamRuntime from "./runtime"

import { makeGlobalNode } from "@turenlabs/core/effect/app-node"
import { AgentV2 } from "@turenlabs/core/agent"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { extractStepOutput } from "../loop/scheduler"
import { Cause, Context, Duration, Effect, Exit, Layer } from "effect"

const POLL_INTERVAL = Duration.seconds(2)
const LEASE_MS = Duration.toMillis(Duration.minutes(5))
const RENEW_INTERVAL = Duration.minutes(1)
const CANCELLATION_INTERVAL = Duration.seconds(1)

export class Service extends Context.Service<Service, {}>()("@forge/TeamRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const owner = `${process.pid}:${crypto.randomUUID()}`
    const active = new Map<string, SessionV2.ID>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        active.values(),
        (sessionID) => sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(() => active.clear())), Effect.asVoid),
    )

    const execute = Effect.fn("TeamRuntime.execute")(function* (task: TeamWorkspace.TaskExecution) {
      const sessionID = SessionV2.ID.make(task.sessionID)
      active.set(task.id, sessionID)
      const location = Location.Ref.make({ directory: AbsolutePath.make(task.execution.directory) })
      const heartbeat = Effect.gen(function* () {
        yield* Effect.sleep(RENEW_INTERVAL)
        yield* team.renewTask({ id: task.id, owner, leaseMs: LEASE_MS })
      }).pipe(
        Effect.mapError((reason) => new LeaseLostError(reason)),
        Effect.catchDefect((reason) => Effect.fail(new LeaseLostError(reason))),
        Effect.forever,
      )
      const cancellation = Effect.gen(function* () {
        yield* Effect.sleep(CANCELLATION_INTERVAL)
        const status = (yield* team.getTask(task.id)).status
        if (status === "cancelled") return yield* Effect.fail(new TaskCancelledError())
        if (status === "stale") return yield* Effect.fail(new LeaseLostError("Task became stale"))
      }).pipe(
        Effect.mapError((reason) => (reason instanceof TaskCancelledError ? reason : new LeaseLostError(reason))),
        Effect.catchDefect((reason) => Effect.fail(new LeaseLostError(reason))),
        Effect.forever,
      )

      const exit = yield* Effect.raceFirst(
        Effect.gen(function* () {
          if (task.execution.agent) {
            const agent = yield* AgentV2.Service.use((service) =>
              service.get(AgentV2.ID.make(task.execution.agent!)),
            ).pipe(Effect.provide(locations.get(location)))
            if (!agent) {
              const started = yield* team
                .startTask({ id: task.id, owner })
                .pipe(Effect.mapError((reason) => new LeaseLostError(reason)))
              if (started.status !== "running") return
              return yield* team.finishTask({
                id: task.id,
                owner,
                status: "failed",
                error: `Agent '${task.execution.agent}' not found in workspace`,
              })
            }
          }

          const session = yield* sessions.get(sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", () =>
              sessions.create({
                id: sessionID,
                location,
                title: task.execution.name,
                agent: task.execution.agent,
                model: task.execution.model,
                metadata: { team: { taskID: task.id, teammateID: task.teammateID, roomID: task.roomID } },
              }),
            ),
          )
          const messageID = SessionMessage.ID.make(`msg_team_${task.id}`)
          yield* sessions.prompt({
            id: messageID,
            sessionID: session.id,
            prompt: {
              text: `Team context: roomID=${task.roomID}; teammateID=${task.teammateID}; handle=@${task.execution.handle}.
The team_read, team_configure_factory, and team_update_teammate tools are available through tool discovery.
Use these tools only when the user requests factory setup or teammate edits. Do not call them implicitly.

${task.execution.prompt}`,
            },
            owner: "automation",
            resume: false,
          })
          const started = yield* team
            .startTask({ id: task.id, owner })
            .pipe(Effect.mapError((reason) => new LeaseLostError(reason)))
          if (started.status !== "running") return
          yield* sessions.resumePending(session.id)
          const inputStatus = yield* sessions.inputStatus({ sessionID: session.id, messageID })
          if (inputStatus?.status === "cancelled") {
            yield* team.cancelTask(task.id)
            return
          }
          const messages = yield* sessions.messages({
            sessionID: session.id,
            order: "asc",
            cursor: { id: messageID, direction: "next" },
          })
          const sourceMessageIDs = messages
            .filter((message) => message.type === "assistant")
            .map((message) => message.id)
            .slice(0, 256)
          const final = messages.findLast(
            (message): message is SessionMessage.Assistant =>
              message.type === "assistant" && message.time.completed !== undefined,
          )
          if (!final) {
            return yield* team.finishTask({
              id: task.id,
              owner,
              status: "failed",
              error: "Session did not produce a completed assistant response",
              sourceMessageIDs,
            })
          }
          if (final.error) {
            return yield* team.finishTask({ id: task.id, owner, status: "failed", error: final.error.message, sourceMessageIDs })
          }
          const text = extractStepOutput(messages).text
          yield* team.finishTask({
            id: task.id,
            owner,
            status: "succeeded",
            text,
            sourceMessageIDs,
          })
        }),
        Effect.raceFirst(heartbeat, cancellation),
      ).pipe(Effect.exit)

      active.delete(task.id)
      if (Exit.isSuccess(exit)) return
      const latest = yield* team.getTask(task.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (latest?.status === "cancelled" || Cause.squash(exit.cause) instanceof TaskCancelledError) {
        yield* sessions
          .cancelPendingInput({ sessionID, messageID: SessionMessage.ID.make(`msg_team_${task.id}`) })
          .pipe(Effect.catch(() => Effect.void))
        yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
        return
      }
      if (Cause.hasInterrupts(exit.cause) || Cause.squash(exit.cause) instanceof LeaseLostError) {
        yield* sessions
          .cancelPendingInput({ sessionID, messageID: SessionMessage.ID.make(`msg_team_${task.id}`) })
          .pipe(Effect.catch(() => Effect.void))
        yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
        return
      }
      yield* team.finishTask({ id: task.id, owner, status: "failed", error: causeMessage(exit.cause) })
    })

    const scan = Effect.gen(function* () {
      yield* team.syncDutyReports()
      yield* team.syncFactoryRuns()
      const available = 32 - active.size
      if (available <= 0) return
      const tasks = yield* team.claimTasks({ owner, limit: available, leaseMs: LEASE_MS })
      yield* Effect.forEach(
        tasks.filter((task) => task.status === "claimed"),
        (task) =>
          execute(task).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Team task failed", { taskID: task.id, cause: Cause.pretty(cause) }),
            ),
            Effect.forkScoped,
          ),
        { discard: true },
      )
    }).pipe(Effect.catchCause((cause) => Effect.logError("Team runtime scan failed", { cause: Cause.pretty(cause) })))

    yield* scan.pipe(Effect.andThen(Effect.sleep(POLL_INTERVAL)), Effect.forever, Effect.forkScoped)
    return Service.of({})
  }),
)

function causeMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return `${String(error._tag)}${"sessionID" in error ? ` for session ${String(error.sessionID)}` : ""}`
  }
  return String(error)
}

class LeaseLostError extends Error {
  constructor(readonly reason: unknown) {
    super("Team task lease could not be renewed")
  }
}

class TaskCancelledError extends Error {
  constructor() {
    super("Team task was cancelled")
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [TeamWorkspace.node, SessionV2.node, LocationServiceMap.node],
})
