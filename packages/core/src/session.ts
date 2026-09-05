export * as SessionV2 from "./session"
export * as SessionHarness from "./session/harness"
export * from "./session/schema"

import { DateTime, Deferred, Effect, Layer, Schema, Context, Stream } from "effect"
import { INACTIVE_AFTER_MS, INTERNAL_METADATA_KEY, ListAnchor } from "@turenlabs/schema/session"
import { and, asc, desc, eq, gt, inArray, like, lt, lte, or, sql, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@turenlabs/schema/prompt-input"
import { SessionRecovery } from "@turenlabs/schema/session-recovery"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { SessionHistory } from "./session/history"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { SessionStatus } from "./session/status"
import { Revert } from "@turenlabs/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@turenlabs/schema/durable-event-manifest"
import { SessionGoal } from "./session/goal"
import { SessionTranscriptAdoption } from "./session/transcript-adoption"
import { SessionLegacyExecution } from "./session/legacy-execution"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { KeyedMutex } from "./effect/keyed-mutex"
import { SessionCommand } from "./session/command"
import { SessionCompaction } from "./session/compaction"
import { SessionShell } from "./session/shell"
import { LoopRunTable } from "./loop/sql"
import { QuestionV2 } from "./question"
import { SessionCreation } from "./session/creation"
import { SessionTaskV2 } from "./session/task"
import { SessionOperation } from "./session/operation"
import { SessionReplay } from "./session/replay"
import { SessionSwarm } from "./session/swarm"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  roots: Schema.Boolean.pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
  internal: Schema.Literal("lobby").pipe(Schema.optional),
  inactive: Schema.Boolean.pipe(Schema.optional),
  inactivityThreshold: Schema.Finite.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  title?: string
  metadata?: Readonly<Record<string, unknown>>
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export class InterruptionTimeoutError extends Schema.TaggedErrorClass<InterruptionTimeoutError>()(
  "Session.InterruptionTimeoutError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class AutomationOwnedError extends Schema.TaggedErrorClass<AutomationOwnedError>()(
  "Session.AutomationOwnedError",
  {
    sessionID: SessionSchema.ID,
  },
) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type AdoptionFailure =
  | SessionTranscriptAdoption.AdoptionError
  | SessionLegacyExecution.QuiescenceUnavailableError
export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | InterruptionTimeoutError
  | PromptConflictError
  | SessionTaskV2.OwnedSessionError
  | AdoptionFailure

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError | AdoptionFailure>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined, NotFoundError | AdoptionFailure>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError | AdoptionFailure>
  readonly pendingInputs: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ReadonlyArray<SessionInput.Admitted>, NotFoundError>
  readonly inputStatus: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionInput.OutboxItem | undefined, NotFoundError>
  readonly outbox: (input: {
    sessionID: SessionSchema.ID
    limit: number
    cursor?: number
    status?: SessionInput.Status
  }) => Effect.Effect<{ items: ReadonlyArray<SessionInput.OutboxItem>; next?: number }, NotFoundError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<
    { events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean; latest: number },
    NotFoundError
  >
  readonly replay: (input: {
    query: string
    limit: number
    cursor?: string
  }) => Effect.Effect<SessionReplay.Page, SessionReplay.QueryError>
  readonly replayHistory: (input: {
    sessionID: SessionSchema.ID
    cursor?: EventV2.ID
    anchor?: EventV2.ID
    direction?: "before" | "after"
    limit: number
  }) => Effect.Effect<SessionReplay.HistoryPage, NotFoundError | SessionReplay.QueryError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError | SessionTaskV2.OwnedSessionError | AdoptionFailure>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | SessionTaskV2.OwnedSessionError | AdoptionFailure>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    agent?: AgentV2.ID
    model?: ModelV2.Ref
    resume?: boolean
    owner?: "automation"
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | PromptConflictError
    | SessionTaskV2.OwnedSessionError
    | SessionRevert.GoalBoundaryError
    | AutomationOwnedError
    | AdoptionFailure
  >
  readonly cancelPendingInput: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<boolean, NotFoundError | SessionTaskV2.OwnedSessionError>
  readonly resumePending: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | SessionRunner.RunError | AdoptionFailure>
  readonly shell: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    timeout?: number
  }) => Effect.Effect<
    SessionMessage.Shell,
    NotFoundError | SessionTaskV2.OwnedSessionError | AdoptionFailure | SessionShell.Error
  >
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments: string
    agent?: AgentV2.ID
    model?: ModelV2.Ref
    files?: ReadonlyArray<PromptInput.FileAttachment>
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | SessionTaskV2.OwnedSessionError
    | AdoptionFailure
    | PromptConflictError
    | SessionRevert.GoalBoundaryError
    | SessionCommand.Error
  >
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<
    void,
    NotFoundError | SessionTaskV2.OwnedSessionError | AdoptionFailure | SessionRunner.CompactError
  >
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | SessionRunner.RunError | AdoptionFailure | AutomationOwnedError>
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | AdoptionFailure>
  readonly recover: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionRecovery.Outcome, NotFoundError | MessageDecodeError | AdoptionFailure>
  readonly interrupt: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    void,
    | SessionTaskV2.OwnedSessionError
    | InterruptionTimeoutError
    | SessionTaskV2.ConflictError
    | SessionTaskV2.ActiveLimitError
  >
  readonly interruptAll: () => Effect.Effect<{ readonly interrupted: number; readonly failed: number }>
  readonly goal: {
    readonly get: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<SessionGoal.Info | undefined, NotFoundError | SessionGoal.NotFoundError>
    readonly set: (
      input: Omit<SessionGoal.CreateInput, "messageID"> & { readonly messageID?: SessionMessage.ID },
    ) => Effect.Effect<
      SessionGoal.Info,
      | NotFoundError
      | SessionTaskV2.OwnedSessionError
      | SessionGoal.NotFoundError
      | SessionGoal.ConflictError
      | SessionRevert.GoalBoundaryError
      | AdoptionFailure
    >
    readonly edit: (
      input: SessionGoal.EditInput,
    ) => Effect.Effect<
      SessionGoal.Info,
      | NotFoundError
      | SessionTaskV2.OwnedSessionError
      | SessionGoal.NotFoundError
      | SessionGoal.ConflictError
      | SessionGoal.InvalidStateError
      | AdoptionFailure
    >
    readonly status: (
      input: SessionGoal.StatusInput,
    ) => Effect.Effect<
      SessionGoal.Info,
      | NotFoundError
      | SessionTaskV2.OwnedSessionError
      | SessionGoal.NotFoundError
      | SessionGoal.ConflictError
      | SessionGoal.InvalidStateError
      | AdoptionFailure
    >
    readonly clear: (
      input: SessionGoal.ClearInput,
    ) => Effect.Effect<
      void,
      | NotFoundError
      | SessionTaskV2.OwnedSessionError
      | SessionGoal.NotFoundError
      | SessionGoal.ConflictError
      | AdoptionFailure
    >
  }
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      Revert.State,
      NotFoundError | SessionTaskV2.OwnedSessionError | MessageNotFoundError | Snapshot.Error | AdoptionFailure
    >
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | SessionTaskV2.OwnedSessionError | Snapshot.Error | AdoptionFailure>
    readonly commit: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<
      void,
      NotFoundError | SessionTaskV2.OwnedSessionError | SessionRevert.GoalBoundaryError | AdoptionFailure
    >
  }
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const primary = isWithReplicas(db) ? db.$primary : db
    const events = yield* EventV2.Service
    const creation = yield* SessionCreation.Service
    const tasks = yield* SessionTaskV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const goals = yield* SessionGoal.Service
    const adoption = yield* SessionTranscriptAdoption.Service
    const shellRegistry = yield* SessionShell.Registry
    const operations = yield* SessionOperation.Service
    const goalAdmissions = KeyedMutex.makeUnsafe<"admission">()
    const commandAdmissions = KeyedMutex.makeUnsafe<SessionMessage.ID>()
    const manualCompactions = new Map<SessionSchema.ID, Set<Deferred.Deferred<void>>>()
    // The O(1) cutover disables legacy synchronous replay triggers before any new writes.
    yield* SessionReplay.ensure(primary).pipe(Effect.orDie)
    const replayBackfillStart = yield* Deferred.make<void>()
    yield* Deferred.await(replayBackfillStart).pipe(
      Effect.andThen(SessionReplay.backfill(primary)),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )
    if (yield* SessionReplay.enabled(primary).pipe(Effect.orDie))
      yield* Deferred.succeed(replayBackfillStart, undefined)
    const authorizeAutomationMutation = Effect.fn("V2Session.authorizeAutomationMutation")(function* (
      sessionID: SessionSchema.ID,
      owner?: "automation",
    ) {
      if (owner === "automation") return
      const active = yield* primary
        .select({ id: LoopRunTable.id })
        .from(LoopRunTable)
        .where(and(eq(LoopRunTable.session_id, sessionID), inArray(LoopRunTable.status, ["claimed", "running"])))
        .get()
        .pipe(Effect.orDie)
      if (active) return yield* new AutomationOwnedError({ sessionID })
    })
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect, source?: SessionInput.Source | null) =>
      decodeMessage({
        ...row.data,
        ...(row.type === "user" && source ? { source } : {}),
        id: row.id,
        type: row.type,
      }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )
    const locationShell = (session: SessionSchema.Info) =>
      SessionShell.Service.pipe(Effect.provide(locations.get(session.location)))
    // A prompt steered while the agent waits on a question means "do this
    // instead". Left pending, each side waits on the other: the parked turn
    // blocks the steer's promotion and the composer message looks ignored.
    // Rejection resolves the stalemate — the parked turn halts as
    // user-declined, and the wake that follows delivers the steer in a fresh
    // turn that still sees the unanswered question in history. Queued
    // deliveries leave the dock alone: "after you finish" still lets the user
    // answer it.
    const dismissPendingQuestions = Effect.fn("V2Session.dismissPendingQuestions")(function* (
      session: SessionSchema.Info,
    ) {
      const questions = yield* QuestionV2.Service.pipe(Effect.provide(locations.get(session.location)))
      const pending = (yield* questions.list()).filter((request) => request.sessionID === session.id)
      yield* Effect.forEach(
        pending,
        (request) => questions.reject(request.id).pipe(Effect.catchTag("QuestionV2.NotFoundError", () => Effect.void)),
        { discard: true },
      )
    })
    const locationCommand = (session: SessionSchema.Info) =>
      SessionCommand.Service.pipe(Effect.provide(locations.get(session.location)))
    const wakeUnlessShellActive = (session: SessionSchema.Info) =>
      shellRegistry
        .active(session.id)
        .pipe(Effect.flatMap((active) => (active ? Effect.void : execution.wake(session.id))))
    const commitAdmissionBoundary = Effect.fn("V2Session.commitAdmissionBoundary")(function* (
      session: SessionSchema.Info,
    ) {
      yield* SessionRevert.commit(session).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
      )
    })
    const admitAtBoundary = Effect.fn("V2Session.admitAtBoundary")(function* (input: {
      readonly session: SessionSchema.Info
      readonly messageID: SessionMessage.ID
      readonly prompt: Prompt
      readonly delivery: SessionInput.Delivery
      readonly agent?: AgentV2.ID
      readonly model?: ModelV2.Ref
      readonly command?: SessionInput.CommandIntent
      readonly kind: SessionInput.IdentityKind
    }) {
      yield* adoption.ensure(input.session)
      const expected = {
        kind: input.kind,
        sessionID: input.session.id,
        messageID: input.messageID,
        prompt: input.prompt,
        delivery: input.delivery,
        agent: input.agent,
        model: input.model,
        command: input.command,
      }
      const identity = yield* SessionInput.findIdentity(primary, input.messageID)
      if (identity) {
        if (!SessionInput.equivalentIdentity(identity, expected))
          return yield* new PromptConflictError({
            sessionID: input.session.id,
            messageID: input.messageID,
          })
        const admitted =
          identity.state === "active"
            ? ((yield* SessionInput.find(primary, input.messageID)) ?? identity.admitted!)
            : identity.admitted!
        return {
          admitted,
          created: false,
          reverted: identity.state === "reverted",
        } as const
      }
      const existing = yield* SessionInput.find(primary, input.messageID)
      const command = yield* SessionInput.findCommand(primary, input.messageID)
      if (existing) {
        if (!SessionInput.equivalent(existing, expected) || !SessionInput.equivalentCommand(command, input.command))
          return yield* new PromptConflictError({
            sessionID: input.session.id,
            messageID: input.messageID,
          })
        return { admitted: existing, created: false, reverted: false } as const
      }
      const admitted = yield* SessionInput.admit(primary, events, {
        id: input.messageID,
        sessionID: input.session.id,
        prompt: input.prompt,
        delivery: input.delivery,
        agent: input.agent,
        model: input.model,
        command: input.command,
        kind: input.kind,
        location: input.session.location,
        ...(input.session.revert ? { revert: { messageID: input.session.revert.messageID } } : {}),
      }).pipe(
        Effect.catchDefect((defect): Effect.Effect<never, PromptConflictError | SessionRevert.GoalBoundaryError> => {
          if (defect instanceof SessionInput.LifecycleConflict)
            return Effect.fail(new PromptConflictError({ sessionID: input.session.id, messageID: input.messageID }))
          if (defect instanceof SessionRevert.GoalBoundaryError) return Effect.fail(defect)
          return Effect.die(defect)
        }),
      )
      if (
        !SessionInput.equivalent(admitted, expected) ||
        !SessionInput.equivalentCommand(yield* SessionInput.findCommand(primary, input.messageID), input.command)
      )
        return yield* new PromptConflictError({
          sessionID: input.session.id,
          messageID: input.messageID,
        })
      return { admitted, created: true, reverted: false } as const
    })

    const recover = Effect.fn("V2Session.recover")(function* (sessionID: SessionSchema.ID) {
      const session = yield* primary
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ sessionID })
      const info = fromRow(session)
      yield* adoption.ensure(info)
      if (yield* shellRegistry.active(sessionID)) return SessionRecovery.Running.make({ status: "running" })
      if ((yield* execution.active).has(sessionID)) return SessionRecovery.Running.make({ status: "running" })
      if (session.time_compacting !== null) {
        // A compaction was started but crashed before publishing a terminal event.
        // Publish Compaction.Failed to clean up the stale state and notify subscribers.
        yield* events
          .publish(
            SessionEvent.Compaction.Failed,
            {
              sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              mode: "manual",
              reason: "interrupted",
            },
            { location: info.location },
          )
          .pipe(Effect.ignore)
        yield* primary
          .update(SessionTable)
          .set({ time_compacting: null, time_updated: sql`${SessionTable.time_updated}` })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }

      const tailRow = yield* primary
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            or(eq(SessionMessageTable.type, "shell"), eq(SessionMessageTable.type, "assistant")),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const tail = tailRow ? yield* decode(tailRow) : undefined
      // Recovery runs on this service's global fiber, which has no
      // Location.Service, so every settlement below passes the Session's
      // placement explicitly. Without it the frames publish unlocated and every
      // per-instance event stream drops them, leaving a live client rendering an
      // interrupted turn as still running until it refetches.
      const interruption = yield* Effect.gen(function* () {
        if (tail?.type === "shell" && !tail.time.completed) {
          if (!(yield* shellRegistry.claim(sessionID))) return { type: "running" } as const
          const reason = SessionShell.INTERRUPTED_ERROR
          yield* events
            .publish(
              SessionEvent.Shell.Ended,
              {
                sessionID,
                callID: tail.callID,
                timestamp: yield* DateTime.now,
                output: reason,
                status: "failed",
                error: reason,
              },
              { location: info.location },
            )
            .pipe(Effect.ensuring(shellRegistry.release(sessionID)))
          return { type: "shell", shellMessageID: tail.id, reason } as const
        }
        if (tail?.type !== "assistant" || tail.time.completed) return
        const reason = "Provider turn was interrupted by process restart and was not replayed."
        for (const tool of tail.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(
            SessionEvent.Tool.Failed,
            {
              sessionID,
              assistantMessageID: tail.id,
              callID: tool.id,
              timestamp: yield* DateTime.now,
              error: SessionMessage.UnknownError.make({ type: "unknown", message: reason }),
              provider: {
                executed: tool.provider?.executed === true,
                metadata: tool.provider?.resultMetadata ?? tool.provider?.metadata,
              },
            },
            { location: info.location },
          )
        }
        yield* events.publish(
          SessionEvent.Step.Failed,
          {
            sessionID,
            assistantMessageID: tail.id,
            timestamp: yield* DateTime.now,
            error: SessionMessage.UnknownError.make({ type: "unknown", message: reason }),
          },
          { location: info.location },
        )
        const goal = yield* goals.get(sessionID).pipe(Effect.orDie)
        if (goal?.status === "active")
          yield* goals
            .status({
              sessionID,
              goalID: goal.id,
              expectedRevision: goal.revision,
              status: "paused",
            })
            .pipe(Effect.orDie)
        return { type: "assistant", assistantMessageID: tail.id, reason } as const
      })
      if (interruption?.type === "running") return SessionRecovery.Running.make({ status: "running" })
      // Settle a durable status that outlived the drain that wrote it. This is the only path that
      // clears a Session interrupted *mid-retry*: the retry wait happens before the publisher
      // starts the assistant message, so there is no incomplete tail for the sweep above to find,
      // and the `retry` row would otherwise describe a countdown that nothing is counting.
      if (interruption !== undefined || session.status === "busy" || session.status === "retry")
        yield* SessionStatus.set(primary, sessionID, {
          type: "interrupted",
          ...(interruption ? { message: interruption.reason } : {}),
        })
      const goal = yield* goals.get(sessionID).pipe(Effect.orDie)
      // A stale run is durable, but an older build could leave the goal active when the stream
      // died with an untyped defect or a retry wait outlived its process. Repair that state without
      // replaying the same provider request on reconnect; an explicit goal resume remains the
      // recovery boundary.
      const staleRun = session.status !== "idle"
      if (staleRun && goal?.status === "active")
        yield* goals
          .status({
            sessionID,
            goalID: goal.id,
            expectedRevision: goal.revision,
            status: "paused",
          })
          .pipe(Effect.orDie)
      const pending =
        (yield* SessionInput.hasPending(primary, sessionID, "steer")) ||
        (yield* SessionInput.hasPending(primary, sessionID, "queue"))
      // A terminal failure can still look continuation-shaped in projected history. Only an
      // explicit pending input is safe to wake from that state; never infer a provider replay.
      const continuation = yield* SessionHistory.needsContinuation(primary, sessionID)
      const next =
        pending || (!staleRun && (goal?.status === "active" || continuation))
          ? ("scheduled" as const)
          : ("idle" as const)
      if (next === "scheduled") yield* execution.wake(sessionID)
      if (interruption?.type === "shell")
        return SessionRecovery.ShellInterrupted.make({
          status: "interrupted",
          shellMessageID: interruption.shellMessageID,
          reason: interruption.reason,
          next,
        })
      if (interruption?.type === "assistant")
        return SessionRecovery.Interrupted.make({
          status: "interrupted",
          assistantMessageID: interruption.assistantMessageID,
          reason: interruption.reason,
          next,
        })
      if (next === "idle") return SessionRecovery.Idle.make({ status: "idle" })
      return SessionRecovery.Scheduled.make({ status: "scheduled" })
    })

    const interruptSessions = (sessions: ReadonlyArray<SessionSchema.ID>) =>
      Effect.forEach(
        sessions,
        (childSessionID) =>
          execution.interrupt(childSessionID).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => Effect.fail(new InterruptionTimeoutError({ sessionID: childSessionID })),
            }),
          ),
        { concurrency: "unbounded", discard: true },
      )

    const interrupt = Effect.fn("V2Session.interrupt")((sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        yield* tasks.authorizeMutation({ sessionID })
        const manual = manualCompactions.get(sessionID)
        if (manual)
          yield* Effect.forEach(manual, (cancellation) => Deferred.succeed(cancellation, undefined), {
            discard: true,
          })
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(
              tasks.cancelRootWithInterrupt({
                rootSessionID: sessionID,
                interrupt: interruptSessions,
              }),
            )
            const session = yield* store.get(sessionID)
            if (session && (yield* shellRegistry.active(sessionID))) {
              const shell = yield* locationShell(session)
              yield* restore(shell.interrupt(sessionID))
            }
            yield* restore(execution.interrupt(sessionID))
            // A spawn already inside its uninterruptible admission may have been waiting for the
            // first task-cancellation lease. Once the parent fiber has stopped, sweep once more so
            // that child cannot escape the root cascade.
            yield* restore(
              tasks.cancelRootWithInterrupt({
                rootSessionID: sessionID,
                interrupt: interruptSessions,
              }),
            )
          }),
        ).pipe(operations.withLock(sessionID))
      }),
    )

    const interruptAll = Effect.fn("V2Session.interruptAll")(function* () {
      const outcomesByRoot = new Map<SessionSchema.ID, boolean>()
      const interruptActive = Effect.fn("V2Session.interruptAll.pass")(function* () {
        const active = new Set([
          ...(yield* execution.active),
          ...(yield* shellRegistry.sessions),
          ...manualCompactions.keys(),
        ])
        const roots = new Set(
          yield* Effect.forEach(
            active,
            (sessionID) => tasks.owner(sessionID).pipe(Effect.map((task) => task?.rootSessionID ?? sessionID)),
            { concurrency: "unbounded" },
          ),
        )
        const outcomes = yield* Effect.forEach(
          roots,
          (sessionID) =>
            interrupt(sessionID).pipe(
              Effect.match({
                onFailure: () => ({ sessionID, success: false as const }),
                onSuccess: () => ({ sessionID, success: true as const }),
              }),
            ),
          { concurrency: "unbounded" },
        )
        outcomes.forEach((outcome) => outcomesByRoot.set(outcome.sessionID, outcome.success))
      })

      yield* interruptActive()
      // Catch work that crossed an uninterruptible admission boundary while the first snapshot
      // was settling. Work admitted after this second snapshot began was not running at activation.
      yield* interruptActive()
      return {
        interrupted: Array.from(outcomesByRoot.values()).filter(Boolean).length,
        failed: Array.from(outcomesByRoot.values()).filter((success) => !success).length,
      }
    })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        return yield* creation.create(input)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = input.inactive === undefined ? SessionTable.time_created : SessionTable.time_updated
        const conditions: SQL[] = []
        if (input.internal !== "lobby")
          conditions.push(
            and(
              sql`${SessionTable.id} NOT LIKE 'ses_lobby_%'`,
              sql`coalesce(json_extract(${SessionTable.metadata}, ${`$."${INTERNAL_METADATA_KEY}"`}), 0) != 1`,
            )!,
          )
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.roots) conditions.push(sql`${SessionTable.parent_id} IS NULL`)
        if (input.archived === false) conditions.push(sql`${SessionTable.time_archived} IS NULL`)
        if (input.archived === true) conditions.push(sql`${SessionTable.time_archived} IS NOT NULL`)
        if (input.inactive !== undefined) {
          const threshold = input.inactivityThreshold ?? Date.now() - INACTIVE_AFTER_MS
          conditions.push(
            input.inactive ? lte(SessionTable.time_updated, threshold) : gt(SessionTable.time_updated, threshold),
          )
        }
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* adoption.ensure(session)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* primary
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        // Human scrollback follows durable order. Model context is selected separately by SessionHistory.
        const query = primary
          .select({ message: SessionMessageTable, source: SessionInputTable.source })
          .from(SessionMessageTable)
          .leftJoin(SessionInputTable, eq(SessionInputTable.id, SessionMessageTable.id))
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, (row) =>
          decode(row.message, row.source),
        )
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* adoption.ensure(session)
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        yield* adoption.ensure(session)
        return yield* store.context(sessionID)
      }),
      pendingInputs: Effect.fn("V2Session.pendingInputs")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionInput.pending(primary, sessionID)
      }),
      inputStatus: Effect.fn("V2Session.inputStatus")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* SessionInput.inputStatus(primary, input)
      }),
      outbox: Effect.fn("V2Session.outbox")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* SessionInput.outbox(primary, input)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* Effect.all({
          latest: EventV2.latestSequence(primary, input.sessionID),
          page: EventV2.readAggregate(db, {
            ...input,
            aggregateID: input.sessionID,
            manifest: SessionDurable,
          }),
        }).pipe(Effect.map(({ latest, page }) => ({ ...page, latest })))
      }),
      replay: Effect.fn("V2Session.replay")((input) =>
        Effect.gen(function* () {
          yield* SessionReplay.ensure(primary).pipe(Effect.orDie)
          yield* SessionReplay.enable(primary).pipe(Effect.orDie)
          yield* Deferred.succeed(replayBackfillStart, undefined)
          yield* SessionReplay.backfillBatch(primary).pipe(Effect.orDie)
          return yield* SessionReplay.search(primary, input)
        }),
      ),
      replayHistory: Effect.fn("V2Session.replayHistory")(function* (input) {
        yield* result.get(input.sessionID)
        yield* SessionReplay.ensure(primary).pipe(Effect.orDie)
        return yield* SessionReplay.history(primary, input)
      }),
      prompt: Effect.fn("V2Session.prompt")((input) => {
        const startedAt = Date.now()
        const phase = (name: string) =>
          Effect.logInfo("V2 prompt admission phase", {
            phase: name,
            sessionID: input.sessionID,
            elapsedMs: Date.now() - startedAt,
          })
        return phase("requested").pipe(
          Effect.andThen(
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* phase("lock_acquired")
                const session = yield* result.get(input.sessionID)
                yield* phase("session_loaded")
                yield* authorizeAutomationMutation(input.sessionID, input.owner)
                yield* tasks.authorizeMutation({ sessionID: input.sessionID })
                yield* phase("authorized")
                const messageID = input.id ?? SessionMessage.ID.create()
                const prompt = resolvePrompt(input.prompt, messageID)
                const delivery = input.delivery ?? "steer"
                const admission = yield* admitAtBoundary({
                  session,
                  messageID,
                  prompt,
                  delivery,
                  agent: input.agent,
                  model: input.model,
                  kind: "prompt",
                })
                yield* phase("admitted")
                if (input.resume !== false && !admission.reverted) {
                  if (delivery === "steer") yield* dismissPendingQuestions(session)
                  yield* phase("questions_dismissed")
                  yield* wakeUnlessShellActive(session)
                  yield* phase("wake_scheduled")
                }
                return admission.admitted
              }),
            ).pipe(operations.withLock(input.sessionID)),
          ),
        )
      }),
      cancelPendingInput: Effect.fn("V2Session.cancelPendingInput")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            yield* tasks.authorizeMutation({ sessionID: input.sessionID })
            const source = yield* primary
              .select({ source: SessionInputTable.source })
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, input.messageID))
              .get()
              .pipe(Effect.orDie)
            const cancelled = yield* SessionInput.cancelPending(primary, {
              sessionID: input.sessionID,
              id: input.messageID,
            })
            if (cancelled && source?.source === "subagent_board")
              yield* execution.retry?.(input.sessionID) ?? Effect.void
            return cancelled
          }),
        ).pipe(operations.withLock(input.sessionID)),
      ),
      shell: Effect.fn("V2Session.shell")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            yield* tasks.authorizeMutation({ sessionID: input.sessionID })
            yield* adoption.ensure(session)
            const shell = yield* locationShell(session)
            return yield* shell.start({
              sessionID: input.sessionID,
              messageID: input.id ?? SessionMessage.ID.create(),
              command: input.command,
              timeout: input.timeout,
              beforeStart: Effect.gen(function* () {
                const active = (yield* execution.active).has(input.sessionID)
                const pending =
                  (yield* SessionInput.hasPending(primary, input.sessionID, "steer")) ||
                  (yield* SessionInput.hasPending(primary, input.sessionID, "queue"))
                const goal = yield* goals.get(input.sessionID).pipe(Effect.orDie)
                if (!active && !pending && goal?.status !== "active") return
                return yield* new SessionShell.SessionBusyError({ sessionID: input.sessionID })
              }),
              after: execution.wake(input.sessionID),
            })
          }),
        ).pipe(operations.withLock(input.sessionID)),
      ),
      command: Effect.fn("V2Session.command")((input) => {
        const messageID = input.id ?? SessionMessage.ID.create()
        const command = SessionInput.CommandIntent.make({
          command: input.command,
          arguments: input.arguments,
          agent: input.agent,
          model: input.model,
          ...(input.files?.length ? { files: [...input.files] } : {}),
        })
        return Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            yield* tasks.authorizeMutation({ sessionID: input.sessionID })
            yield* adoption.ensure(session)
            const identity = yield* SessionInput.findIdentity(primary, messageID)
            if (identity) {
              if (
                identity.owner !== "input" ||
                identity.kind !== "command" ||
                !identity.admitted ||
                identity.admitted.sessionID !== input.sessionID ||
                !SessionInput.equivalentCommand(identity.command, command)
              )
                return yield* new PromptConflictError({
                  sessionID: input.sessionID,
                  messageID,
                })
              const admitted =
                identity.state === "active"
                  ? ((yield* SessionInput.find(primary, messageID)) ?? identity.admitted)
                  : identity.admitted
              if (input.resume !== false && identity.state !== "reverted") yield* wakeUnlessShellActive(session)
              return admitted
            }
            const existing = yield* SessionInput.find(primary, messageID)
            if (existing) {
              const stored = yield* SessionInput.findCommand(primary, messageID)
              if (existing.sessionID !== input.sessionID || !SessionInput.equivalentCommand(stored, command))
                return yield* new PromptConflictError({
                  sessionID: input.sessionID,
                  messageID,
                })
              if (input.resume !== false) yield* wakeUnlessShellActive(session)
              return existing
            }
            const commands = yield* locationCommand(session)
            const resolved = yield* commands.resolve({
              command: input.command,
              arguments: input.arguments,
              agent: input.agent,
              sessionAgent: session.agent,
              model: input.model,
              files: input.files,
            })
            const prompt = resolvePrompt(resolved.prompt, messageID)
            const admission = yield* admitAtBoundary({
              session,
              messageID,
              prompt,
              delivery: "steer",
              agent: resolved.agent,
              model: resolved.model,
              command,
              kind: "command",
            })
            if (input.resume !== false && !admission.reverted) yield* wakeUnlessShellActive(session)
            return admission.admitted
          }),
        ).pipe(commandAdmissions.withLock(messageID), operations.withLock(input.sessionID))
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            yield* tasks.authorizeMutation({ sessionID: input.sessionID })
            yield* adoption.ensure(session)
            yield* events.publish(
              SessionEvent.AgentSwitched,
              {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                agent: input.agent,
              },
              { location: session.location },
            )
          }),
        ).pipe(operations.withLock(input.sessionID)),
      ),
      switchModel: Effect.fn("V2Session.switchModel")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            yield* tasks.authorizeMutation({ sessionID: input.sessionID })
            yield* adoption.ensure(session)
            if (
              session.model?.providerID === input.model.providerID &&
              session.model.id === input.model.id &&
              (session.model.variant ?? "default") === (input.model.variant ?? "default")
            )
              return
            yield* events.publish(
              SessionEvent.ModelSwitched,
              {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                model: input.model,
              },
              { location: session.location },
            )
          }),
        ).pipe(operations.withLock(input.sessionID)),
      ),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        const cancellation = yield* Deferred.make<void>()
        const registered = manualCompactions.get(input.sessionID) ?? new Set<Deferred.Deferred<void>>()
        registered.add(cancellation)
        manualCompactions.set(input.sessionID, registered)
        yield* Effect.raceFirst(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              // Compaction appends a message and moves the read cutoff, so it cannot run beside a
              // turn that is already building a request from the pre-compaction history. Refuse
              // instead of racing: the same busy set `shell` guards against.
              const busy =
                (yield* execution.active).has(input.sessionID) ||
                (yield* shellRegistry.active(input.sessionID)) ||
                (yield* SessionInput.hasPending(primary, input.sessionID, "steer")) ||
                (yield* SessionInput.hasPending(primary, input.sessionID, "queue")) ||
                (yield* goals.get(input.sessionID).pipe(Effect.orDie))?.status === "active"
              if (busy)
                return yield* new SessionCompaction.FailedError({
                  sessionID: input.sessionID,
                  reason: "sessionBusy",
                })
              yield* restore(
                SessionRunner.Service.use((runner) => runner.compact({ sessionID: input.sessionID })).pipe(
                  Effect.provide(locations.get(session.location)),
                ),
              )
            }),
          ).pipe(operations.withLock(input.sessionID)),
          Deferred.await(cancellation).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              registered.delete(cancellation)
              if (registered.size === 0) manualCompactions.delete(input.sessionID)
            }),
          ),
        )
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: Effect.all([execution.active, shellRegistry.sessions]).pipe(
        Effect.map(([agent, shell]) => new Set([...agent, ...shell])),
      ),
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        const join = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(sessionID)
            yield* authorizeAutomationMutation(sessionID)
            yield* adoption.ensure(session)
            if (yield* shellRegistry.active(sessionID)) return
            return yield* execution.claimResume(sessionID)
          }).pipe(operations.withLock(sessionID)),
        )
        if (join) yield* join
      }),
      resumePending: Effect.fn("V2Session.resumePending")(function* (sessionID) {
        const join = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(sessionID)
            yield* adoption.ensure(session)
            if (yield* shellRegistry.active(sessionID)) return
            return yield* execution.claimPending?.(sessionID) ?? execution.claimResume(sessionID)
          }).pipe(operations.withLock(sessionID)),
        )
        if (join) yield* join
      }),
      wake: Effect.fn("V2Session.wake")((sessionID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(sessionID)
            yield* adoption.ensure(session)
            yield* wakeUnlessShellActive(session)
          }),
        ).pipe(operations.withLock(sessionID)),
      ),
      recover: (sessionID) => recover(sessionID).pipe(operations.withLock(sessionID)),
      interrupt,
      interruptAll,
      goal: {
        get: Effect.fn("V2Session.goal.get")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* goals.get(sessionID)
        }),
        set: Effect.fn("V2Session.goal.set")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              const create = {
                ...input,
                messageID: input.messageID ?? SessionMessage.ID.create(),
                ...(session.revert ? { revert: { messageID: session.revert.messageID } } : {}),
              }
              const preflight = yield* goals.preflightCreate(create)
              if (preflight.type === "exact") {
                if (preflight.wake) yield* wakeUnlessShellActive(session)
                return preflight.goal
              }
              const goal = yield* goals.create(create).pipe(
                Effect.catchDefect(
                  (defect): Effect.Effect<never, SessionGoal.ConflictError | SessionRevert.GoalBoundaryError> => {
                    if (defect instanceof SessionInput.LifecycleConflict)
                      return Effect.fail(
                        new SessionGoal.ConflictError({
                          sessionID: input.sessionID,
                          goalID: input.id,
                          message: "Goal message ID conflicts with an existing durable record",
                        }),
                      )
                    if (defect instanceof SessionRevert.GoalBoundaryError) return Effect.fail(defect)
                    return Effect.die(defect)
                  },
                ),
              )
              yield* wakeUnlessShellActive(session)
              return goal
            }),
          ).pipe(goalAdmissions.withLock("admission"), operations.withLock(input.sessionID)),
        ),
        edit: Effect.fn("V2Session.goal.edit")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              const goal = yield* goals.edit(input)
              if (goal.status === "active") yield* wakeUnlessShellActive(session)
              return goal
            }),
          ).pipe(operations.withLock(input.sessionID)),
        ),
        status: Effect.fn("V2Session.goal.status")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              const goal = yield* goals.status(input)
              if (goal.status === "active") {
                const currentStatus = yield* primary
                  .select({ status: SessionTable.status })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, input.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (currentStatus?.status === "failed")
                  yield* SessionStatus.set(primary, input.sessionID, { type: "idle" })
                yield* wakeUnlessShellActive(session)
                return goal
              }
              yield* execution.interrupt(input.sessionID)
              return goal
            }),
          ).pipe(operations.withLock(input.sessionID)),
        ),
        clear: Effect.fn("V2Session.goal.clear")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              yield* goals.clear(input)
              yield* execution.interrupt(input.sessionID)
            }),
          ).pipe(operations.withLock(input.sessionID)),
        ),
      },
      revert: {
        stage: Effect.fn("V2Session.revert.stage")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              yield* tasks.authorizeMutation({ sessionID: input.sessionID })
              yield* adoption.ensure(session)
              return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ).pipe(operations.withLock(input.sessionID)),
        ),
        clear: Effect.fn("V2Session.revert.clear")((sessionID) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(sessionID)
              yield* tasks.authorizeMutation({ sessionID })
              yield* adoption.ensure(session)
              yield* SessionRevert.clear(session).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ).pipe(operations.withLock(sessionID)),
        ),
        commit: Effect.fn("V2Session.revert.commit")((sessionID) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(sessionID)
              yield* tasks.authorizeMutation({ sessionID })
              yield* commitAdmissionBoundary(session)
              yield* execution.retry?.(sessionID) ?? Effect.void
            }),
          ).pipe(operations.withLock(sessionID)),
        ),
      },
    })

    return result
  }),
)

const resolvePrompt = (raw: PromptInput.Prompt, messageID: SessionMessage.ID) => {
  const input = SessionSwarm.normalize(raw, messageID)
  return Prompt.make({
    text: input.text,
    parts: input.parts,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionCreation.node,
    SessionTaskV2.node,
    SessionOperation.node,
    SessionExecution.node,
    SessionStore.node,
    SessionGoal.node,
    SessionShell.registryNode,
    SessionTranscriptAdoption.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
