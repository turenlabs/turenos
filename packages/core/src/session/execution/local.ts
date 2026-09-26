import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import { Cause, Effect, Layer, Option, Stream } from "effect"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionTranscriptAdoption } from "../transcript-adoption"
import { SessionTaskV2 } from "../task"
import { SessionEvent } from "../event"
import { SessionInputTable, SessionTable } from "../sql"
import { SessionOperation } from "../operation"
import { SessionShell } from "../shell"
import { Config } from "../../config"
import { Reflection } from "../../reflection"
import { SessionMessage } from "../message"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const adoption = yield* SessionTranscriptAdoption.Service
    const tasks = yield* SessionTaskV2.Service
    const operations = yield* SessionOperation.Service
    const shellRegistry = yield* SessionShell.Registry
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const reflection = yield* Reflection.Service
    const primary = Database.primary(database.db)
    // Stale subagent advisories must not become future provider turns: the task that produced
    // them died with the process, and their durable state is still readable via list_agents.
    yield* primary
      .update(SessionInputTable)
      .set({ time_cancelled: Date.now() })
      .where(
        and(
          inArray(SessionInputTable.source, ["subagent_board", "subagent_settle", "subagent_advisory"]),
          isNull(SessionInputTable.promoted_seq),
          isNull(SessionInputTable.time_cancelled),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    const scope = yield* Effect.scope
    const reflectionSettings = Effect.fn("SessionExecutionLocal.reflectionSettings")(function* (
      session: SessionSchema.Info,
    ) {
      return yield* Effect.gen(function* () {
        const config = yield* Effect.serviceOption(Config.Service)
        return Option.isSome(config)
          ? Reflection.reflectionSettings(yield* config.value.entries())
          : { enabled: undefined, interval: undefined }
        }).pipe(Effect.provide(locations.get(session.location)))
    })
    const promotionLimit = Effect.fn("SessionExecutionLocal.promotionLimit")(function* (
      rootSessionID: SessionSchema.ID,
    ) {
      const session = yield* store.get(rootSessionID)
      if (!session) return SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT
      return yield* Effect.gen(function* () {
        const config = yield* Effect.serviceOption(Config.Service)
        return Option.isSome(config)
          ? SessionTaskV2.resolveActiveLimit(Config.latest(yield* config.value.entries(), "subagents")?.max_concurrent)
          : SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT
      }).pipe(Effect.provide(locations.get(session.location)))
    })
    let wakeAdvisory: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    const advisoryWakeRetries = new Map<SessionSchema.ID, boolean>()
    const advisoryBusyEpochs = new Map<SessionSchema.ID, { since: number; warnedAt: number }>()
    let scheduleAdvisoryWake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let attemptAdvisoryWake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    const advisoryBusyReasons = Effect.fn("SessionExecutionLocal.advisoryBusyReasons")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const compacting = yield* primary
        .select({ timeCompacting: SessionTable.time_compacting })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return { shell: yield* shellRegistry.active(sessionID), compacting: compacting?.timeCompacting != null }
    })
    const advisoryBusy = Effect.fn("SessionExecutionLocal.advisoryBusy")(function* (sessionID: SessionSchema.ID) {
      const reasons = yield* advisoryBusyReasons(sessionID)
      return reasons.shell || reasons.compacting
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      wakeAdvisory: (sessionID) => wakeAdvisory(sessionID),
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force, control) {
        const startedAt = Date.now()
        const phase = (name: string) =>
          Effect.logInfo("Session execution drain phase", {
            phase: name,
            sessionID,
            elapsedMs: Date.now() - startedAt,
          })
        yield* phase("entered")
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        yield* phase("session_loaded")
        yield* adoption.ensure(session).pipe(Effect.orDie)
        yield* phase("adoption_ready")
        const reflectionConfig = Reflection.isEligible(session) ? yield* reflectionSettings(session) : undefined
        if (reflectionConfig)
          yield* reflection.reconcile({
            session,
            enabled: reflectionConfig.enabled,
            interval: reflectionConfig.interval,
          })
        yield* phase("reflection_ready")
        const authorized = yield* tasks.authorizeRun(sessionID).pipe(
          Effect.as(true),
          Effect.catchTag("SessionTask.OwnedSessionError", () => Effect.succeed(false)),
        )
        if (!authorized) return
        yield* phase("authorized")
        if (yield* operations.withLock(sessionID)(advisoryBusy(sessionID))) {
          yield* scheduleAdvisoryWake(sessionID)
          return
        }
        yield* phase("advisory_ready")
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const exit = yield* restore(
              SessionRunner.Service.use((runner) =>
                phase("runner_acquired").pipe(Effect.andThen(runner.run({ sessionID, force, control }))),
              ).pipe(Effect.provide(locations.get(session.location))),
            ).pipe(Effect.exit)
            const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
            // Settlement stays outside the located scope on purpose. It is the
            // drain's guarantee that a task never stays running after its run
            // ends, so it must also cover the run that never started because the
            // Location layers failed or died while building. Task events carry
            // their placement explicitly (SessionTask.locate) rather than reading
            // it from ambient context, so publishing from this unlocated fiber
            // still reaches the right subscribers.
            const settled = yield* tasks
              .settleRun({
                sessionID,
                status:
                  exit._tag === "Success" ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                ...(failure === undefined
                  ? {}
                  : { error: failure instanceof Error ? failure.message : String(failure) }),
              })
              .pipe(Effect.orDie)
            // Settling an orchestrator retires its unfinished workers; their
            // drains are separate sessions that must be stopped explicitly.
            if (settled?.transitioned === true) {
              yield* Effect.forEach(settled.retired, control.interrupt, {
                concurrency: 1,
                discard: true,
              })
              const notified = yield* tasks
                .notifyParent({
                  taskID: settled.task.id,
                  text: settleText(settled.task),
                  source: "subagent_settle",
                  allowTerminal: true,
                  // A deterministic id keeps a crash-replayed settle from admitting twice.
                  messageID: SessionMessage.ID.make(`msg_task_settle_${settled.task.id}_${settled.task.revision}`),
                })
                .pipe(Effect.orDie)
              // Queue delivery plus a coalesced wake mirrors the board-post advisory
              // path; the advisory wake path only schedules shell-job inputs.
              if (notified !== undefined) yield* control.wake(notified.sessionID)
            }
            const latestAssistant =
              exit._tag === "Success"
                ? (yield* store.context(sessionID)).findLast(
                    (message): message is SessionMessage.Assistant => message.type === "assistant",
                  )
                : undefined
            const completed = latestAssistant?.time.completed !== undefined && latestAssistant.error === undefined
            if (completed && reflectionConfig) {
              yield* reflection
                .recordCompletion({
                  session,
                  completionID: latestAssistant.id,
                  enabled: reflectionConfig.enabled,
                  interval: reflectionConfig.interval,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not record completed Session for reflection cadence", cause).pipe(
                      Effect.annotateLogs({ sessionID }),
                    ),
                  ),
                )
            }
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
          }),
        ).pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    scheduleAdvisoryWake = Effect.fn("SessionExecutionLocal.scheduleAdvisoryWake")(function* (
      sessionID: SessionSchema.ID,
    ) {
      if (advisoryWakeRetries.has(sessionID)) {
        advisoryWakeRetries.set(sessionID, true)
        return
      }
      advisoryWakeRetries.set(sessionID, false)
      yield* Effect.gen(function* () {
        yield* Effect.sleep("250 millis")
        yield* attemptAdvisoryWake(sessionID).pipe(Effect.catchCause(() => Effect.void))
        const retryAgain = advisoryWakeRetries.get(sessionID) === true
        advisoryWakeRetries.delete(sessionID)
        if (retryAgain) yield* scheduleAdvisoryWake(sessionID)
      }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
    })
    attemptAdvisoryWake = Effect.fn("SessionExecutionLocal.attemptAdvisoryWake")(function* (
      sessionID: SessionSchema.ID,
    ) {
      yield* operations.withLock(sessionID)(
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (!session) {
            advisoryBusyEpochs.delete(sessionID)
            return
          }
          const busy = yield* advisoryBusyReasons(sessionID)
          if (busy.shell || busy.compacting) {
            // The retry loop is the only thing re-arming a diverted drain. A busy window that
            // outlasts any reasonable shell job or compaction means the mark wedged -- surface
            // it instead of retrying quietly forever.
            const epoch = advisoryBusyEpochs.get(sessionID) ?? { since: Date.now(), warnedAt: 0 }
            advisoryBusyEpochs.set(sessionID, epoch)
            const now = Date.now()
            if (now - epoch.since > 60_000 && now - epoch.warnedAt > 300_000) {
              epoch.warnedAt = now
              yield* Effect.logWarning("Session drain still diverted by advisory busy", {
                sessionID,
                elapsedMs: now - epoch.since,
                ...busy,
              })
            }
            yield* scheduleAdvisoryWake(sessionID)
            return
          }
          advisoryBusyEpochs.delete(sessionID)
          // A diverted drain re-wakes once the busy window clears no matter what admitted it:
          // the runner decides whether durable work remains, so gating the re-wake on one input
          // source stranded every other kind (user prompts, queue advisories, continuations).
          yield* coordinator.wake(sessionID)
        }),
      )
    })
    wakeAdvisory = Effect.fn("SessionExecutionLocal.wakeAdvisory")(function* (sessionID: SessionSchema.ID) {
      yield* scheduleAdvisoryWake(sessionID)
    })
    const wakePendingShellInputs = Effect.fn("SessionExecutionLocal.wakePendingShellInputs")(function* () {
      const highWater = yield* primary
        .get<{ sessionID: string | null }>(
          sql`
          SELECT max(${SessionInputTable.session_id}) AS sessionID
          FROM ${SessionInputTable}
          WHERE ${SessionInputTable.source} = 'shell_job'
            AND ${SessionInputTable.promoted_seq} IS NULL
            AND ${SessionInputTable.time_cancelled} IS NULL
        `,
        )
        .pipe(Effect.orDie)
      const highWaterSessionID = highWater?.sessionID === null ? undefined : highWater?.sessionID
      if (!highWaterSessionID) return
      const wakePage = (afterSessionID?: SessionSchema.ID): Effect.Effect<void> => {
        const conditions = [
          eq(SessionInputTable.source, "shell_job"),
          isNull(SessionInputTable.promoted_seq),
          isNull(SessionInputTable.time_cancelled),
          lte(SessionInputTable.session_id, SessionSchema.ID.make(highWaterSessionID)),
          ...(afterSessionID === undefined ? [] : [gt(SessionInputTable.session_id, afterSessionID)]),
        ]
        return primary
          .selectDistinct({ sessionID: SessionInputTable.session_id })
          .from(SessionInputTable)
          .where(and(...conditions))
          .orderBy(asc(SessionInputTable.session_id))
          .limit(256)
          .all()
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => {
              if (rows.length === 0) return Effect.void
              return Effect.forEach(rows, (row) => coordinator.wakeAdvisory?.(row.sessionID) ?? Effect.void, {
                concurrency: 1,
                discard: true,
              }).pipe(Effect.andThen(wakePage(rows.at(-1)!.sessionID)))
            }),
          )
      }
      yield* wakePage()
    })
    yield* events.subscribe(SessionEvent.PromptAdmitted).pipe(
      Stream.runForEach((event) =>
        event.data.source === "shell_job"
          ? (coordinator.wakeAdvisory?.(event.data.sessionID) ?? Effect.void)
          : Effect.void,
      ),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )
    // A proposal snapshot is durable before this event is published. Queue the adoption turn from
    // the execution owner rather than from the reviewer: the coordinator can atomically retain a
    // forced successor when the parent is active. Idle sessions only receive a no-op pending-work
    // drain, so startup review cannot become post-crash continuation recovery. This closes the
    // race where review finished between a runner's final Harness read and its drain settlement.
    yield* events.subscribe(SessionEvent.Harness.SnapshotCreated).pipe(
      Stream.runForEach((event) =>
        event.data.proposalID === undefined ? Effect.void : coordinator.wakeForced(event.data.sessionID, false),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )
    yield* wakePendingShellInputs()
    // Queued subagents start here: settle, cancel, restart, and commits from
    // another process all free slots without a caller that could wake the child.
    yield* tasks
      .runPromotion(coordinator.wake, promotionLimit)
      .pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    return SessionExecution.Service.of({
      active: coordinator.active,
      claimResume: coordinator.claim,
      claimPending: coordinator.claimPending,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      wakeForced: coordinator.wakeForced,
    })
  }),
)

/** Compact settle advisory admitted to the parent as one queued prompt. */
function settleText(task: SessionTaskV2.Info) {
  const detail = task.status === "completed" ? task.result : task.error
  const label = task.status === "completed" ? "Result" : "Error"
  return [
    "A subagent task reached a terminal state.",
    `${task.status}: ${task.description} (task ${task.id}, agent ${task.agent})`,
    ...(detail === undefined ? [] : [`${label}: ${detail.slice(0, 500)}`]),
    "Collect the full durable report with wait_agents when you need it; otherwise continue your current work.",
  ].join("\n")
}

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionTranscriptAdoption.node,
    SessionTaskV2.node,
    SessionOperation.node,
    SessionShell.registryNode,
    Reflection.node,
  ],
})

export * as SessionExecutionLocal from "./local"
