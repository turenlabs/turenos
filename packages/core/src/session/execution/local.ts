import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm"
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
import { SessionInput } from "../input"
import { SessionTaskV2 } from "../task"
import { SessionEvent } from "../event"
import { SessionInputTable, SessionTable } from "../sql"
import { SessionOperation } from "../operation"
import { SessionShell } from "../shell"
import { TeamBoard } from "../../team/board"
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
    const board = yield* TeamBoard.Service
    const operations = yield* SessionOperation.Service
    const shellRegistry = yield* SessionShell.Registry
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const reflection = yield* Reflection.Service
    const primary = Database.primary(database.db)
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
    let wakeAdvisory: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    const advisoryWakeRetries = new Map<SessionSchema.ID, boolean>()
    let scheduleAdvisoryWake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let attemptAdvisoryWake: (sessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let retryBoardNotifications: (parentSessionID: SessionSchema.ID) => Effect.Effect<void> = () => Effect.void
    let reconcileBoardNotifications: (
      parentSessionID?: SessionSchema.ID,
    ) => Effect.Effect<
      { readonly notes: ReadonlyArray<TeamBoard.Note>; readonly delivered: number },
      TeamBoard.Failure
    > = () => Effect.succeed({ notes: [], delivered: 0 })
    const advisoryBusy = Effect.fn("SessionExecutionLocal.advisoryBusy")(function* (sessionID: SessionSchema.ID) {
      const compacting = yield* primary
        .select({ timeCompacting: SessionTable.time_compacting })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return (yield* shellRegistry.active(sessionID)) || compacting?.timeCompacting !== null
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      wakeAdvisory: (sessionID) => wakeAdvisory(sessionID),
      retry: (parentSessionID) => retryBoardNotifications(parentSessionID),
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
        yield* reconcileBoardNotifications(sessionID).pipe(Effect.orDie)
        yield* phase("board_ready")
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
            yield* tasks
              .settleRun({
                sessionID,
                status:
                  exit._tag === "Success" ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                ...(failure === undefined
                  ? {}
                  : { error: failure instanceof Error ? failure.message : String(failure) }),
              })
              .pipe(Effect.orDie)
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
          if (!session) return
          if (yield* advisoryBusy(sessionID)) {
            yield* scheduleAdvisoryWake(sessionID)
            return
          }
          if (
            !(yield* SessionInput.hasPendingSource(primary, sessionID, "subagent_board")) &&
            !(yield* SessionInput.hasPendingSource(primary, sessionID, "shell_job"))
          )
            return
          yield* coordinator.wake(sessionID)
        }),
      )
    })
    wakeAdvisory = Effect.fn("SessionExecutionLocal.wakeAdvisory")(function* (sessionID: SessionSchema.ID) {
      yield* scheduleAdvisoryWake(sessionID)
    })
    const retryingBoardParents = new Map<SessionSchema.ID, boolean>()
    reconcileBoardNotifications = Effect.fn("SessionExecutionLocal.reconcileBoardNotifications")(function* (
      parentSessionID?: SessionSchema.ID,
    ) {
      const notes = yield* board.pendingParentNotes(parentSessionID === undefined ? undefined : { parentSessionID })
      const delivered = yield* Effect.forEach(
        notes,
        (note) =>
          Effect.gen(function* () {
            const task = yield* tasks.owner(note.authorSessionID)
            if (!task) return 0
            if (parentSessionID !== undefined && task.parentSessionID !== parentSessionID) return 0
            const notification = yield* tasks
              .notifyParent({
                taskID: task.id,
                text: TeamBoard.parentUpdateText(note),
                messageID: TeamBoard.parentNotificationID(note),
                source: "subagent_board",
                allowTerminal: true,
              })
              .pipe(
                Effect.catchTag("SessionTask.NotFoundError", () => Effect.succeed(undefined)),
                Effect.catchTag("SessionTask.ConflictError", () => Effect.succeed(undefined)),
              )
            if (notification?.admitted !== true) return 0
            yield* coordinator.wakeAdvisory?.(notification.sessionID) ?? Effect.void
            yield* board.markParentNotified(note.id)
            return 1
          }),
        { concurrency: 1 },
      )
      return { notes, delivered: delivered.filter((value) => value === 1).length }
    })
    retryBoardNotifications = Effect.fn("SessionExecutionLocal.retryBoardNotifications")(function* (
      parentSessionID: SessionSchema.ID,
    ) {
      if (retryingBoardParents.has(parentSessionID)) {
        retryingBoardParents.set(parentSessionID, true)
        return
      }
      retryingBoardParents.set(parentSessionID, false)
      yield* Effect.gen(function* () {
        yield* Effect.sleep("250 millis")
        const notes = yield* reconcileBoardNotifications(parentSessionID).pipe(
          Effect.catchCause(() => Effect.succeed({ notes: [], delivered: 0 })),
        )
        const retryAgain =
          retryingBoardParents.get(parentSessionID) === true ||
          (notes.notes.length === TeamBoard.MAX_VISIBLE_NOTES && notes.delivered > 0)
        retryingBoardParents.delete(parentSessionID)
        if (retryAgain) yield* retryBoardNotifications(parentSessionID)
      }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
    })
    const wakePendingBoardInputs = Effect.fn("SessionExecutionLocal.wakePendingBoardInputs")(function* () {
      const highWater = yield* primary
        .get<{ sessionID: string | null }>(
          sql`
          SELECT max(${SessionInputTable.session_id}) AS sessionID
          FROM ${SessionInputTable}
          WHERE ${SessionInputTable.source} IN ('subagent_board', 'shell_job')
            AND ${SessionInputTable.promoted_seq} IS NULL
            AND ${SessionInputTable.time_cancelled} IS NULL
        `,
        )
        .pipe(Effect.orDie)
      const highWaterSessionID = highWater?.sessionID === null ? undefined : highWater?.sessionID
      if (!highWaterSessionID) return
      const wakePage = (afterSessionID?: SessionSchema.ID): Effect.Effect<void> => {
        const conditions = [
          sql`${SessionInputTable.source} IN ('subagent_board', 'shell_job')`,
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
        event.data.source === "subagent_board" || event.data.source === "shell_job"
          ? (coordinator.wakeAdvisory?.(event.data.sessionID) ?? Effect.void)
          : event.data.revert
            ? retryBoardNotifications(event.data.sessionID)
            : Effect.void,
      ),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )
    yield* events.subscribe(SessionEvent.Prompted).pipe(
      Stream.runForEach((event) =>
        primary
          .select({ source: SessionInputTable.source })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, event.data.messageID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((input) =>
              input?.source === "subagent_board" ? retryBoardNotifications(event.data.sessionID) : Effect.void,
            ),
          ),
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
    yield* wakePendingBoardInputs()
    yield* reconcileBoardNotifications().pipe(Effect.orDie)
    const remainingNotes = yield* board.pendingParentNotes()
    yield* Effect.forEach(
      remainingNotes,
      (note) =>
        Effect.gen(function* () {
          const task = yield* tasks.owner(note.authorSessionID)
          if (task) yield* retryBoardNotifications(task.parentSessionID)
        }),
      { concurrency: 1, discard: true },
    )
    const pendingParents = yield* board.pendingParentSessions()
    yield* Effect.forEach(pendingParents, retryBoardNotifications, {
      concurrency: 1,
      discard: true,
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      claimResume: coordinator.claim,
      claimPending: coordinator.claimPending,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      wakeForced: coordinator.wakeForced,
      retry: retryBoardNotifications,
    })
  }),
)

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
    TeamBoard.node,
    Reflection.node,
  ],
})

export * as SessionExecutionLocal from "./local"
