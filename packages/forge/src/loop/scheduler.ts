export * as LoopScheduler from "./scheduler"

import { makeGlobalNode } from "@turenlabs/core/effect/app-node"
import { AgentV2 } from "@turenlabs/core/agent"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import { AbsolutePath } from "@turenlabs/core/schema"
import { FileSystemWatcher } from "@turenlabs/schema/filesystem-watcher"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { WorkspaceV2 } from "@turenlabs/core/workspace"
import path from "path"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"

const POLL_INTERVAL = Duration.seconds(5)
const LEASE_MS = Duration.toMillis(Duration.minutes(5))
const RENEW_INTERVAL = Duration.minutes(1)
const CANCELLATION_INTERVAL = Duration.seconds(1)
const CLAIM_LIMIT = 32

/**
 * Process-global scheduling for durable Loop runs. Core owns persistence,
 * overlap exclusion, and the lease state machine.
 *
 * Global on purpose, and it cannot be anything else. Automations are time-driven:
 * a run must fire whether or not anyone has opened its project, so exactly one
 * claimer per process — never one per open Location — owns the due queue. The
 * layer graph agrees: Location services are built inside `LocationServiceMap`,
 * and this scheduler needs `SessionV2`, which needs `LocationServiceMap`, so a
 * Location-scoped scheduler is an unsatisfiable cycle. Per-Location state is
 * reached the way `SessionExecutionLocal` reaches it — resolve the map for the
 * run's own Location at execution time.
 */
export class Service extends Context.Service<Service, {}>()("@forge/LoopScheduler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const loops = yield* Loop.Service
    const team = yield* TeamWorkspace.Service
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const owner = `${process.pid}:${crypto.randomUUID()}`
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const fileDebounce = new Map<string, NodeJS.Timeout>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of fileDebounce.values()) clearTimeout(timer)
        fileDebounce.clear()
      }),
    )

    const execute = Effect.fn("LoopScheduler.execute")(function* (run: Loop.Run) {
      const teammate = yield* team.recordDutyRun({ runID: run.id, loopID: run.loopID })
      if (teammate?.status === "paused") {
        yield* loops.cancelRun({ id: run.id })
        return
      }
      const mission = teammate
        ? `You are ${teammate.name} (@${teammate.handle}), a security teammate.\nMission: ${teammate.mission}\nComplete this duty and report evidence-backed results.\n\n`
        : ""
      const heartbeat = Effect.gen(function* () {
        yield* Effect.sleep(RENEW_INTERVAL)
        yield* loops.renewRun({ id: run.id, owner, leaseMs: LEASE_MS })
      }).pipe(
        Effect.mapError((error) => new LeaseLostError(error)),
        Effect.catchDefect((defect) => Effect.fail(new LeaseLostError(defect))),
        Effect.forever,
      )

      const cancellation = Effect.gen(function* () {
        yield* Effect.sleep(CANCELLATION_INTERVAL)
        if ((yield* loops.getRun({ id: run.id })).status === "cancelled")
          return yield* Effect.fail(new RunCancelledError())
      }).pipe(
        Effect.mapError((error) => (error instanceof RunCancelledError ? error : new LeaseLostError(error))),
        Effect.catchDefect((defect) => Effect.fail(new LeaseLostError(defect))),
        Effect.forever,
      )

      const exit = yield* Effect.raceFirst(
        Effect.gen(function* () {
          const loop = yield* loops.get(run.loopID)

          const snapshot = run.execution ?? {
            title: loop.name,
            prompt: loop.prompt,
            location: loop.location,
            agent: loop.agent,
            model: loop.model,
            skill: loop.skill,
            workflow: loop.workflow,
          }
          if (snapshot.factoryRoomID) {
            const factoryRunID = `frun_${run.id}`
            const factoryRun = yield* team.startFactoryRun({
              id: factoryRunID,
              roomID: snapshot.factoryRoomID,
              sourceLoopRunID: run.id,
              ...(snapshot.prompt.trim() ? { request: snapshot.prompt } : {}),
            })
            const planningTaskID = factoryRun.taskIDs[0]
            if (!planningTaskID) return yield* Effect.fail(new Error("Factory run did not admit a planning task"))
            const planningTask = yield* team.getTask(planningTaskID)
            const planningSessionID = SessionV2.ID.make(planningTask.sessionID)
            yield* loops.recordRunSession({ id: run.id, owner, sessionID: planningSessionID })
            yield* loops.startRun({ id: run.id, owner, sessionID: planningSessionID })
            let current = factoryRun
            while (current.status === "running") {
              yield* Effect.sleep(POLL_INTERVAL)
              current = yield* team.getFactoryRun(factoryRunID)
            }
            const sourceRun = yield* loops.getRun({ id: run.id })
            if (current.status !== "cancelled" && sourceRun.status === "running" && sourceRun.currentStep === 0) {
              yield* loops.completeRunStep({
                id: run.id,
                owner,
                currentStep: 0,
                stepID: "factory",
                output: {
                  text: current.result ?? current.error ?? `Factory run ${current.status}`,
                  json: { factoryRunID, status: current.status },
                  artifacts: [],
                },
              })
            }
            if (current.status === "succeeded") {
              return
            }
            if (current.status === "cancelled") return yield* Effect.fail(new RunCancelledError())
            const failedTask = current.taskIDs[0] ? yield* team.getTask(current.taskIDs[0]) : undefined
            const details = failedTask
              ? `; task ${failedTask.id} status=${failedTask.status} error=${failedTask.error ?? "none"} model=${failedTask.execution.model?.providerID ?? "none"}/${failedTask.execution.model?.id ?? "none"} directory=${failedTask.execution.directory}`
              : ""
            return yield* Effect.fail(
              new Error(
                current.error ??
                  failedTask?.error ??
                  current.result ??
                  `Factory run ${current.status}${details}; source Loop ${sourceRun.status} session=${sourceRun.sessionID ?? "none"}`,
              ),
            )
          }
          const execution = {
            ...snapshot,
            agent: snapshot.agent ?? teammate?.agent,
            model: snapshot.model ?? teammate?.model,
          }
          const ref = Location.Ref.make({
            directory: AbsolutePath.make(execution.location.directory),
            workspaceID: execution.location.workspaceID
              ? WorkspaceV2.ID.make(execution.location.workspaceID)
              : undefined,
          })

          // Agents are Location-scoped, so the run's own Location decides whether its
          // agent exists. Validating against the run's `execution` snapshot rather than
          // the live Loop keeps the check aligned with what actually gets prompted.
          if (execution.agent) {
            const agentID = AgentV2.ID.make(execution.agent)
            const agentInfo = yield* AgentV2.Service.use((agents) => agents.get(agentID)).pipe(
              Effect.provide(locations.get(ref)),
            )
            if (!agentInfo) {
              yield* loops.finishRun({
                id: run.id,
                owner,
                status: "failed",
                error: `Agent '${execution.agent}' not found in workspace`,
              })
              return
            }
          }

          const sessionID = SessionV2.ID.make(run.sessionID ?? `ses_loop_${run.id}`)
          if (!run.sessionID) yield* loops.recordRunSession({ id: run.id, owner, sessionID })
          const session = yield* sessions.get(sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", () =>
              sessions.create({
                id: sessionID,
                location: ref,
                title: execution.title,
                agent: execution.agent,
                model: execution.model,
              }),
            ),
          )

          const triggerPayload: Readonly<Record<string, unknown>> = {
            repository: execution.location.directory,
            directory: execution.location.directory,
            ...(execution.location.workspaceID ? { workspaceID: execution.location.workspaceID } : {}),
            ...(run.triggerPayload ?? {}),
          }
          const workflow = execution.workflow
          if (workflow) {
            let outputs = run.outputs
            yield* Effect.forEach(
              workflow.steps.slice(run.currentStep),
              (step, offset) =>
                Effect.gen(function* () {
                  const index = run.currentStep + offset
                  const context = {
                    trigger: { type: run.trigger, scheduledAt: run.scheduledAt, payload: triggerPayload },
                    steps: outputs,
                  }
                  const whenOutcome = tryEvaluateWhen(step.when, context)
                  if (whenOutcome.error !== undefined) {
                    if (!Loop.shouldContinueOnFailure(step)) return yield* Effect.die(whenOutcome.error)
                    outputs = yield* recordContinuedFailure(
                      loops,
                      run.id,
                      owner,
                      session.id,
                      index,
                      step.id,
                      whenOutcome.error,
                    )
                    return
                  }
                  if (!whenOutcome.value) {
                    outputs = yield* recordSkippedStep(loops, run.id, owner, session.id, index, step.id)
                    return
                  }
                  const messageID = SessionMessage.ID.make(`msg_loop_${run.id}_${step.id}`)
                  const stepEffect = Effect.gen(function* () {
                    const rendered = renderWorkflowStep(step, index, workflow.steps.length, context)
                    yield* sessions.prompt({
                      id: messageID,
                      sessionID: session.id,
                      prompt: { text: mission + rendered },
                      resume: false,
                      owner: "automation",
                      // A step without its own selection inherits the Session's agent and
                      // model, which the Automation set when the Session was created.
                      ...(step.agent ? { agent: step.agent } : {}),
                      ...(step.model ? { model: step.model } : {}),
                    })
                    yield* loops.startRun({ id: run.id, owner, sessionID: session.id, currentStep: index })
                    yield* sessions.resumePending(session.id)
                    const output = extractStepOutput(
                      yield* sessions.messages({
                        sessionID: session.id,
                        order: "asc",
                        cursor: { id: messageID, direction: "next" },
                      }),
                    )
                    outputs = (yield* loops.completeRunStep({
                      id: run.id,
                      owner,
                      currentStep: index,
                      stepID: step.id,
                      output,
                    })).outputs
                  })
                  yield* stepEffect.pipe(
                    Effect.catch((error) =>
                      Loop.shouldContinueOnFailure(step)
                        ? Effect.gen(function* () {
                            outputs = yield* recordContinuedFailure(
                              loops,
                              run.id,
                              owner,
                              session.id,
                              index,
                              step.id,
                              error,
                            )
                          })
                        : Effect.die(error),
                    ),
                  )
                }),
              { concurrency: 1, discard: true },
            )
          } else if (run.currentStep === 0) {
            // A stable prompt identity reconciles a crash after admission but before
            // the run crosses the provider-execution boundary below.
            const prompt = execution.skill
              ? `Load and follow the ${JSON.stringify(execution.skill)} skill for this run.${execution.prompt.trim() ? `\n\nAdditional instructions:\n${execution.prompt}` : ""}`
              : execution.prompt
            const messageID = SessionMessage.ID.make(`msg_loop_${run.id}`)
            yield* sessions.prompt({
              id: messageID,
              sessionID: session.id,
              prompt: { text: mission + prompt },
              resume: false,
              owner: "automation",
            })
            yield* loops.startRun({ id: run.id, owner, sessionID: session.id })
            yield* sessions.resumePending(session.id)
            yield* loops.completeRunStep({
              id: run.id,
              owner,
              currentStep: 0,
              stepID: "result",
              output: extractStepOutput(
                yield* sessions.messages({
                  sessionID: session.id,
                  order: "asc",
                  cursor: { id: messageID, direction: "next" },
                }),
              ),
            })
          }
        }),
        Effect.raceFirst(heartbeat, cancellation),
      ).pipe(Effect.exit)

      if (Exit.isSuccess(exit)) {
        yield* loops.finishRun({ id: run.id, owner, status: "succeeded" })
        return
      }

      const latest = yield* loops.getRun({ id: run.id })
      const sessionID = SessionV2.ID.make(latest.sessionID ?? `ses_loop_${run.id}`)
      if (latest.status === "cancelled" || Cause.squash(exit.cause) instanceof RunCancelledError) {
        const factoryRoomID = latest.execution?.factoryRoomID
        if (factoryRoomID) {
          yield* team.cancelFactoryRun(`frun_${run.id}`).pipe(Effect.catch(() => Effect.void))
          const state = yield* team.state({ roomID: factoryRoomID }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* Effect.forEach(
            state?.tasks.filter((task) => task.factoryRunID === `frun_${run.id}`) ?? [],
            (task) => sessions.interrupt(SessionV2.ID.make(task.sessionID)).pipe(Effect.catch(() => Effect.void)),
            { discard: true },
          )
          return
        }
        const step = latest.execution?.workflow?.steps[latest.currentStep]
        yield* sessions
          .cancelPendingInput({
            sessionID,
            messageID: SessionMessage.ID.make(step ? `msg_loop_${run.id}_${step.id}` : `msg_loop_${run.id}`),
          })
          .pipe(Effect.catch(() => Effect.void))
        yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
        return
      }
      // Interruption or loss of the lease makes the provider outcome
      // unknowable. Stop process-local execution and never replay it.
      if (unknownOutcome(exit.cause)) {
        const factoryRoomID = latest.execution?.factoryRoomID
        if (factoryRoomID) {
          yield* team.cancelFactoryRun(`frun_${run.id}`).pipe(Effect.catch(() => Effect.void))
          const state = yield* team.state({ roomID: factoryRoomID }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* Effect.forEach(
            state?.tasks.filter((task) => task.factoryRunID === `frun_${run.id}`) ?? [],
            (task) => sessions.interrupt(SessionV2.ID.make(task.sessionID)).pipe(Effect.catch(() => Effect.void)),
            { discard: true },
          )
          return
        }
        yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
        return
      }
      yield* loops.finishRun({ id: run.id, owner, status: "failed", error: formatCause(exit.cause) })
    })

    const runClaimed = (run: Loop.Run) =>
      execute(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Loop run execution failed", { runID: run.id, cause: Cause.pretty(cause) }),
        ),
        Effect.forkScoped,
      )

    const scan = Effect.gen(function* () {
      const due = yield* loops.claimDue({ owner, leaseMs: LEASE_MS, limit: CLAIM_LIMIT })
      yield* Effect.forEach(
        due.filter((run) => run.status === "claimed"),
        (run) => runClaimed(run),
        { discard: true },
      )
    }).pipe(Effect.catchCause((cause) => Effect.logError("Loop scheduler scan failed", { cause: Cause.pretty(cause) })))

    const fireAndRun = (
      loopID: string,
      trigger: "file-change" | "session-end",
      payload: Readonly<Record<string, unknown>>,
    ) =>
      loops.fireEvent({ id: loopID, owner, trigger, payload, leaseMs: LEASE_MS }).pipe(
        Effect.flatMap((run) => (run.status === "claimed" ? runClaimed(run) : Effect.void)),
        Effect.catch(() => Effect.void),
      )

    const fireAndExecuteDirect = (
      loopID: string,
      trigger: "file-change" | "session-end",
      payload: Readonly<Record<string, unknown>>,
    ) =>
      loops.fireEvent({ id: loopID, owner, trigger, payload, leaseMs: LEASE_MS }).pipe(
        Effect.flatMap((run) =>
          run.status === "claimed"
            ? execute(run).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Loop run execution failed", { runID: run.id, cause: Cause.pretty(cause) }),
                ),
              )
            : Effect.void,
        ),
        Effect.catch(() => Effect.void),
      )

    const queueFileEvent = (file: string) =>
      Effect.gen(function* () {
        const actives = yield* loops.list()
        for (const info of actives) {
          if (info.status !== "active") continue
          if (info.eventTrigger?.type !== "file-change") continue
          const relative = toLoopRelativePath(info.location.directory, file)
          if (relative === undefined) continue
          if (!Loop.matchesFileTrigger(info.eventTrigger, relative)) continue
          const debounceMs = info.eventTrigger.debounceMs ?? Loop.FILE_CHANGE_DEBOUNCE_DEFAULT_MS
          const payload = { file: relative, event: "change", directory: info.location.directory }
          const existing = fileDebounce.get(info.id)
          if (existing) clearTimeout(existing)
          fileDebounce.set(
            info.id,
            setTimeout(() => {
              fileDebounce.delete(info.id)
              runFork(fireAndExecuteDirect(info.id, "file-change", payload))
            }, debounceMs),
          )
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("Loop file event failed", { cause: Cause.pretty(cause) })))

    const handleSessionEnd = (
      sessionID: string,
      outcome: "success" | "failure",
      agent: string | undefined,
      directory: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (sessionID.startsWith("ses_loop_")) return
        const actives = yield* loops.list()
        for (const info of actives) {
          if (info.status !== "active") continue
          if (info.eventTrigger?.type !== "session-end") continue
          if (directory !== undefined && directory !== info.location.directory) continue
          const config = info.eventTrigger
          if (config.outcomes !== undefined && !config.outcomes.includes(outcome)) continue
          if (config.sessionID !== undefined && config.sessionID !== sessionID) continue
          if (config.agent !== undefined && agent !== undefined && config.agent !== agent) continue
          yield* fireAndRun(info.id, "session-end", {
            sessionID,
            outcome,
            ...(agent === undefined ? {} : { agent }),
            ...(directory === undefined ? {} : { directory }),
          })
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("Loop session event failed", { cause: Cause.pretty(cause) })),
      )

    const fileStream = events.subscribe(FileSystemWatcher.Event.Updated).pipe(
      Stream.runForEach((event) => queueFileEvent(event.data.file)),
      Effect.catchCause((cause) => Effect.logError("Loop file watcher failed", { cause: Cause.pretty(cause) })),
      Effect.forever,
      Effect.forkScoped,
    )

    const sessionSuccess = events.subscribe(SessionEvent.Step.Ended).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = event.data.sessionID as string
          const directory = yield* sessionDirectory(sessions, sessionID)
          const agent = yield* sessionAgent(sessions, sessionID)
          yield* handleSessionEnd(sessionID, "success", agent, directory)
        }),
      ),
      Effect.catchCause((cause) => Effect.logError("Loop session watcher failed", { cause: Cause.pretty(cause) })),
      Effect.forever,
      Effect.forkScoped,
    )

    const sessionFailure = events.subscribe(SessionEvent.Step.Failed).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = event.data.sessionID as string
          const directory = yield* sessionDirectory(sessions, sessionID)
          const agent = yield* sessionAgent(sessions, sessionID)
          yield* handleSessionEnd(sessionID, "failure", agent, directory)
        }),
      ),
      Effect.catchCause((cause) => Effect.logError("Loop session watcher failed", { cause: Cause.pretty(cause) })),
      Effect.forever,
      Effect.forkScoped,
    )

    yield* scan.pipe(Effect.andThen(Effect.sleep(POLL_INTERVAL)), Effect.forever, Effect.forkScoped)
    yield* fileStream
    yield* sessionSuccess
    yield* sessionFailure
    return Service.of({})
  }),
)

function recordSkippedStep(
  loops: Loop.Interface,
  runID: string,
  owner: string,
  sessionID: string,
  currentStep: number,
  stepID: string,
) {
  return Effect.gen(function* () {
    yield* loops.startRun({ id: runID, owner, sessionID, currentStep }).pipe(Effect.catch(() => Effect.void))
    const after = yield* loops
      .completeRunStep({ id: runID, owner, currentStep, stepID, output: { text: "", artifacts: [] } })
      .pipe(Effect.catch(() => loops.getRun({ id: runID })))
    return after.outputs
  })
}

function recordContinuedFailure(
  loops: Loop.Interface,
  runID: string,
  owner: string,
  sessionID: string,
  currentStep: number,
  stepID: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error)
  const output: Loop.StepOutput = { text: `Step failed but continuing: ${message}`, artifacts: [] }
  return Effect.gen(function* () {
    yield* loops.startRun({ id: runID, owner, sessionID, currentStep }).pipe(Effect.catch(() => Effect.void))
    const after = yield* loops
      .completeRunStep({ id: runID, owner, currentStep, stepID, output })
      .pipe(Effect.catch(() => loops.getRun({ id: runID })))
    return after.outputs
  })
}

function tryEvaluateWhen(
  when: string | undefined,
  context: Parameters<typeof Loop.evaluateWhen>[1],
): { readonly value: boolean; readonly error?: undefined } | { readonly value: false; readonly error: unknown } {
  try {
    return { value: Loop.evaluateWhen(when, context) }
  } catch (error) {
    return { value: false, error }
  }
}

export function toLoopRelativePath(loopDirectory: string, file: string) {
  const relative = path.relative(loopDirectory, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/")
}

function sessionDirectory(sessions: SessionV2.Interface, sessionID: string) {
  return sessions.get(SessionV2.ID.make(sessionID)).pipe(
    Effect.map((session) => (session.location?.directory as string | undefined) ?? undefined),
    Effect.catch(() => Effect.succeed(undefined as string | undefined)),
  )
}

function sessionAgent(sessions: SessionV2.Interface, sessionID: string) {
  return sessions.get(SessionV2.ID.make(sessionID)).pipe(
    Effect.map((session) => (session.agent as string | undefined) ?? undefined),
    Effect.catch(() => Effect.succeed(undefined as string | undefined)),
  )
}

function formatCause(cause: Cause.Cause<unknown>) {
  const failure = Cause.squash(cause)
  return failure instanceof Error ? failure.message : String(failure)
}

function unknownOutcome(cause: Cause.Cause<unknown>) {
  return Cause.hasInterrupts(cause) || Cause.squash(cause) instanceof LeaseLostError
}

class LeaseLostError extends Error {
  constructor(readonly reason: unknown) {
    super("Loop execution lease could not be renewed")
  }
}

class RunCancelledError extends Error {
  constructor() {
    super("Loop run was cancelled")
  }
}

export function renderWorkflowStep(
  step: Loop.WorkflowStep,
  index: number,
  total: number,
  context: Parameters<typeof Loop.resolveBindings>[1] = {
    trigger: { type: "manual", scheduledAt: 0, payload: {} },
    steps: {},
  },
) {
  return [
    `Automation step ${index + 1} of ${total}: ${step.name}`,
    "Complete only this step. Keep your findings in this Session so the next step can use them.",
    step.type === "skill"
      ? `Load and follow the ${JSON.stringify(step.skill)} skill.${step.instructions.trim() ? `\nAdditional instructions: ${Loop.resolveBindings(step.instructions, context)}` : ""}`
      : Loop.resolveBindings(step.prompt, context),
    index === total - 1 ? "This is the final step. Its response is delivered inside TurenOS." : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function extractStepOutput(messages: ReadonlyArray<SessionMessage.Message>): Loop.StepOutput {
  let final: SessionMessage.Assistant | undefined
  const artifacts: Loop.StepArtifact[] = []
  for (const message of messages) {
    if (message.type === "user") break
    if (message.type !== "assistant") continue
    if (message.time.completed !== undefined && message.error === undefined) final = message
    for (const path of message.snapshot?.files ?? []) artifacts.push({ type: "changed", path })
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      for (const path of part.state.outputPaths ?? []) artifacts.push({ type: "output", path })
      for (const content of part.state.content) {
        if (content.type === "file") {
          artifacts.push({
            type: "file",
            uri: content.uri,
            mime: content.mime,
            ...(content.name ? { name: content.name } : {}),
          })
        }
      }
    }
  }
  const text = final?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? ""
  const parsed = decodeJson(text)
  return {
    text,
    ...(Option.isSome(parsed) ? { json: parsed.value } : {}),
    artifacts,
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Loop.node, TeamWorkspace.node, SessionV2.node, LocationServiceMap.node, EventV2.node],
})
