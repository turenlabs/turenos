import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { Loop } from "@turenlabs/core/loop"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { ConflictError, InvalidRequestError } from "@turenlabs/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const teamError = (error: unknown) => {
  const tag = tagOf(error)
  const message = error instanceof Error ? error.message : "Invalid Team request"
  if (tag === "Team.ConflictError" || tag === "ConflictError") return new ConflictError({ message })
  return new InvalidRequestError({ message, kind: tag })
}

const stopTask = (team: TeamWorkspace.Interface, sessions: SessionV2.Interface, taskID: string) =>
  Effect.gen(function* () {
    const task = yield* team.cancelTask(taskID).pipe(Effect.mapError(teamError))
    if (task.status !== "cancelled") return task
    yield* sessions
      .cancelPendingInput({
        sessionID: SessionV2.ID.make(task.sessionID),
        messageID: SessionMessage.ID.make(`msg_team_${task.id}`),
      })
      .pipe(Effect.catch(() => Effect.void))
    yield* sessions.interrupt(SessionV2.ID.make(task.sessionID)).pipe(Effect.catch(() => Effect.void))
    return task
  })

export const TeamHandler = HttpApiBuilder.group(Api, "server.team", (handlers) =>
  handlers
    .handle(
      "team.state",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.state(ctx.query).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.roomCreate",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.createRoom(ctx.payload).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.roomEdit",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.editRoom({ id: ctx.params.roomID, ...ctx.payload }).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.roomArchive",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.archiveRoom(ctx.params.roomID).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.roomRestore",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.restoreRoom(ctx.params.roomID).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.roomDelete",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        yield* team.deleteRoom(ctx.params.roomID).pipe(Effect.mapError(teamError))
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "team.teammateCreate",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.createTeammate(ctx.payload).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.teammateEdit",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.editTeammate({ id: ctx.params.teammateID, ...ctx.payload }).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.messagePost",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.postMessage(ctx.payload).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.dutyAttach",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team
          .attachDuty({ teammateID: ctx.params.teammateID, loopID: ctx.payload.loopID })
          .pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.factoryConfigure",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team
          .configureFactory({ roomID: ctx.params.roomID, config: ctx.payload })
          .pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.factoryRun",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team
          .startFactoryRun({ roomID: ctx.params.roomID, ...ctx.payload })
          .pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.factoryRunGet",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        return yield* team.getFactoryRun(ctx.params.runID).pipe(Effect.mapError(teamError))
      }),
    )
    .handle(
      "team.factoryRunCancel",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        const sessions = yield* SessionV2.Service
        const run = yield* team.cancelFactoryRun(ctx.params.runID).pipe(Effect.mapError(teamError))
        yield* Effect.forEach(
          run.taskIDs,
          (id) =>
            Effect.gen(function* () {
              const task = yield* team.getTask(id).pipe(Effect.mapError(teamError))
              if (task.status !== "cancelled") return
              const sessionID = SessionV2.ID.make(task.sessionID)
              yield* sessions
                .cancelPendingInput({ sessionID, messageID: SessionMessage.ID.make(`msg_team_${task.id}`) })
                .pipe(Effect.catch(() => Effect.void))
              yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
            }),
          { discard: true },
        )
        return run
      }),
    )
    .handle(
      "team.taskCancel",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        const sessions = yield* SessionV2.Service
        return yield* stopTask(team, sessions, ctx.params.taskID)
      }),
    )
    .handle(
      "team.teammateStop",
      Effect.fn(function* (ctx) {
        const team = yield* TeamWorkspace.Service
        const sessions = yield* SessionV2.Service
        const loops = yield* Loop.Service
        const teammate = yield* team.getTeammate(ctx.params.teammateID).pipe(Effect.mapError(teamError))
        const tasks = yield* team.tasksForTeammate(ctx.params.teammateID).pipe(Effect.mapError(teamError))
        yield* Effect.forEach(
          tasks.filter((task) => task.status === "queued" || task.status === "claimed" || task.status === "running"),
          (task) => stopTask(team, sessions, task.id).pipe(Effect.catch(() => Effect.void)),
          { discard: true },
        )
        const state = yield* team.state({ roomID: teammate.roomID }).pipe(Effect.mapError(teamError))
        for (const duty of state.duties.filter((item) => item.teammateID === ctx.params.teammateID)) {
          const runs = yield* loops.listRuns(duty.loopID).pipe(Effect.catch(() => Effect.succeed([])))
          yield* Effect.forEach(
            runs.filter((run) => run.status === "claimed" || run.status === "running"),
            (run) =>
              loops.cancelRun({ loopID: duty.loopID, id: run.id }).pipe(
                Effect.flatMap((cancelled) => {
                  if (!cancelled.sessionID) return Effect.void
                  const step = cancelled.execution?.workflow?.steps[cancelled.currentStep]
                  return sessions
                    .cancelPendingInput({
                      sessionID: SessionV2.ID.make(cancelled.sessionID),
                      messageID: SessionMessage.ID.make(
                        step ? `msg_loop_${cancelled.id}_${step.id}` : `msg_loop_${cancelled.id}`,
                      ),
                    })
                    .pipe(
                      Effect.catch(() => Effect.void),
                      Effect.andThen(
                        sessions
                          .interrupt(SessionV2.ID.make(cancelled.sessionID))
                          .pipe(Effect.catch(() => Effect.void)),
                      ),
                    )
                }),
                Effect.catch(() => Effect.void),
              ),
            { discard: true },
          )
        }
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
