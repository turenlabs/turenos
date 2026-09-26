export * as SessionTaskV2 from "./task"

import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { SessionTask } from "@turenlabs/schema/session-task"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Cause, Context, DateTime, Deferred, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { AbsolutePath, NonNegativeInt } from "../schema"
import { SessionCreation } from "./creation"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionStore } from "./store"
import { SessionV1 } from "../v1/session"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionTaskActorClaimTable, SessionTaskOperationTable, SessionTaskTable } from "./task.sql"
import { TeamBoard } from "../team/board"

export const ID = SessionTask.ID
export type ID = SessionTask.ID
export const OperationID = SessionTask.OperationID
export type OperationID = SessionTask.OperationID
export const Status = SessionTask.Status
export type Status = SessionTask.Status
export const Info = SessionTask.Info
export type Info = SessionTask.Info
export const Operation = SessionTask.Operation
export type Operation = SessionTask.Operation
export const Authority = SessionTask.Authority
export type Authority = SessionTask.Authority
export const Actor = SessionTask.Actor
export type Actor = SessionTask.Actor
export const MAX_DESCRIPTION_LENGTH = SessionTask.MAX_DESCRIPTION_LENGTH
export const MAX_PROMPT_BYTES = SessionTask.MAX_PROMPT_BYTES
export const MAX_AUTHORITY_BYTES = SessionTask.MAX_AUTHORITY_BYTES
export const MAX_RESULT_LENGTH = SessionTask.MAX_RESULT_LENGTH
export const MAX_ERROR_LENGTH = SessionTask.MAX_ERROR_LENGTH
export const MAX_TOOL_CALL_ID_LENGTH = SessionTask.MAX_TOOL_CALL_ID_LENGTH
export const MAX_AGENT_ID_LENGTH = SessionTask.MAX_AGENT_ID_LENGTH
export const MAX_MODEL_ID_LENGTH = SessionTask.MAX_MODEL_ID_LENGTH
export const MAX_PROVIDER_ID_LENGTH = SessionTask.MAX_PROVIDER_ID_LENGTH
export const MAX_VARIANT_ID_LENGTH = SessionTask.MAX_VARIANT_ID_LENGTH
export const REQUEST_HASH_LENGTH = SessionTask.REQUEST_HASH_LENGTH
export const RESULT_TRUNCATED_SUFFIX = "\n[result truncated]"
export const MAX_LIST_PAGE_LIMIT = 101

export const MAX_DEPTH = SessionTask.MAX_DEPTH
export const MAX_TASKS_PER_ROOT = SessionTask.MAX_TASKS_PER_ROOT
export const MAX_WAVE_NAME_LENGTH = SessionTask.MAX_WAVE_NAME_LENGTH
export const MAX_SPAWN_BATCH = SessionTask.MAX_SPAWN_BATCH
export const MIN_ACTIVE_PER_ROOT = SessionTask.MIN_ACTIVE_PER_ROOT
export const DEFAULT_ACTIVE_PER_ROOT = SessionTask.DEFAULT_ACTIVE_PER_ROOT
export const MAX_ACTIVE_PER_ROOT = SessionTask.MAX_ACTIVE_PER_ROOT

/**
 * Resolves the configured concurrent-subagent limit for one root Session.
 *
 * Configuration is location scoped and this service is global, so callers read
 * `subagents.max_concurrent` and hand the value in. Clamping here rather than in
 * the config schema is deliberate: a value outside the schema's checks makes the
 * whole config document undecodable, and the loader drops undecodable documents
 * silently, so a typo in this one field would take a user's permissions with it.
 * The hard cap therefore lives at the point of enforcement, where it also binds
 * programmatic callers that never went through config at all.
 */
export function resolveActiveLimit(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ACTIVE_PER_ROOT
  return Math.min(Math.max(Math.trunc(value), MIN_ACTIVE_PER_ROOT), MAX_ACTIVE_PER_ROOT)
}

/**
 * Slots running orchestrators may hold out of an active limit. An orchestrator
 * mostly waits on its own workers, and those workers draw from the same root
 * pool, so orchestrators filling every slot would deadlock the graph. Capping
 * them at half keeps at least half the pool for workers.
 */
export function orchestratorLimit(activeLimit: number) {
  return Math.floor(activeLimit / 2)
}

const EXTERNAL_CHANGE_POLL_MS = 250
export const DURABLE_EVENT_TYPES = new Set([
  EventV2.versionedType(SessionEvent.Task.Updated.type, 1),
  EventV2.versionedType(SessionEvent.Task.OperationUpdated.type, 1),
])

export function isDurableEventType(type: string) {
  return DURABLE_EVENT_TYPES.has(type)
}

export const isProtectedAggregate = Effect.fn("SessionTask.isProtectedAggregate")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const taskID = aggregateID.startsWith("tsk_") ? ID.make(aggregateID) : undefined
  const sessionID = aggregateID.startsWith("ses") ? SessionSchema.ID.make(aggregateID) : undefined
  if (!taskID && !sessionID) return false
  const row = yield* db
    .select({ id: SessionTaskTable.id })
    .from(SessionTaskTable)
    .where(
      taskID
        ? eq(SessionTaskTable.id, taskID)
        : or(
            eq(SessionTaskTable.root_session_id, sessionID!),
            eq(SessionTaskTable.parent_session_id, sessionID!),
            eq(SessionTaskTable.child_session_id, sessionID!),
          ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const protectedAggregateIDs = Effect.fn("SessionTask.protectedAggregateIDs")(function* (
  db: Database.Interface["db"],
) {
  const rows = yield* db
    .select({
      id: SessionTaskTable.id,
      rootSessionID: SessionTaskTable.root_session_id,
      parentSessionID: SessionTaskTable.parent_session_id,
      childSessionID: SessionTaskTable.child_session_id,
    })
    .from(SessionTaskTable)
    .all()
    .pipe(Effect.orDie)
  return new Set<string>(rows.flatMap((row) => [row.id, row.rootSessionID, row.parentSessionID, row.childSessionID]))
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionTask.NotFoundError", {
  taskID: ID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionTask.ConflictError", {
  resource: Schema.String,
  message: Schema.String,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("SessionTask.InvalidStateError", {
  taskID: ID,
  status: Status,
  message: Schema.String,
}) {}

export class DepthLimitError extends Schema.TaggedErrorClass<DepthLimitError>()("SessionTask.DepthLimitError", {
  parentSessionID: SessionSchema.ID,
  maximum: Schema.Int,
}) {}

export class ActiveLimitError extends Schema.TaggedErrorClass<ActiveLimitError>()("SessionTask.ActiveLimitError", {
  rootSessionID: SessionSchema.ID,
  maximum: Schema.Int,
  active: Schema.Int,
}) {}

export class SwarmLimitError extends Schema.TaggedErrorClass<SwarmLimitError>()("SessionTask.SwarmLimitError", {
  sessionID: SessionSchema.ID,
  maximum: NonNegativeInt,
  admitted: NonNegativeInt,
}) {}

export class QueueLimitError extends Schema.TaggedErrorClass<QueueLimitError>()("SessionTask.QueueLimitError", {
  rootSessionID: SessionSchema.ID,
  maximum: Schema.Int,
}) {}

export class OrchestrateError extends Schema.TaggedErrorClass<OrchestrateError>()("SessionTask.OrchestrateError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export class AuthorityError extends Schema.TaggedErrorClass<AuthorityError>()("SessionTask.AuthorityError", {
  parentTaskID: ID,
  message: Schema.String,
}) {}

export class OwnedSessionError extends Schema.TaggedErrorClass<OwnedSessionError>()("SessionTask.OwnedSessionError", {
  sessionID: SessionSchema.ID,
  taskID: ID,
  message: Schema.String,
}) {}

class ProjectionConflict extends Error {
  constructor(
    readonly resource: string,
    message: string,
  ) {
    super(message)
  }
}

export type Error =
  | NotFoundError
  | ConflictError
  | InvalidStateError
  | DepthLimitError
  | ActiveLimitError
  | SwarmLimitError
  | QueueLimitError
  | OrchestrateError
  | AuthorityError
  | OwnedSessionError

export type SpawnInput = {
  readonly id?: ID
  readonly operationID?: OperationID
  readonly actor: Actor
  readonly agent: Info["agent"]
  readonly model?: Info["model"]
  readonly prompt: Prompt
  readonly description: string
  readonly authority: Authority
  /** Optional fleet tag scoped to the parent Session; see {@link MAX_WAVE_NAME_LENGTH}. */
  readonly wave?: string
  /** Configured concurrent-subagent limit; clamped by {@link resolveActiveLimit}. */
  readonly activeLimit?: number
}

export type SendInput = {
  readonly operationID?: OperationID
  readonly actor: Actor
  readonly taskID: ID
  readonly prompt: Prompt
  /** Configured concurrent-subagent limit; clamped by {@link resolveActiveLimit}. */
  readonly activeLimit?: number
}

export type InterruptInput = {
  readonly operationID?: OperationID
  readonly actor: Actor
  readonly taskID: ID
}

export type Prepared = {
  readonly task: Info
  readonly operation: Operation
  readonly wake: boolean
}

export type ListInput = {
  readonly rootSessionID?: SessionSchema.ID
  readonly parentSessionID?: SessionSchema.ID
  readonly wave?: string
  readonly statuses?: ReadonlyArray<Status>
}

export type Counts = {
  readonly queued: number
  readonly active: number
  readonly terminal: number
}

export interface Interface {
  readonly spawn: (
    input: SpawnInput,
  ) => Effect.Effect<
    Prepared,
    | NotFoundError
    | ConflictError
    | InvalidStateError
    | DepthLimitError
    | ActiveLimitError
    | SwarmLimitError
    | QueueLimitError
    | OrchestrateError
    | AuthorityError
  >
  readonly send: (
    input: SendInput,
  ) => Effect.Effect<Prepared, NotFoundError | ConflictError | InvalidStateError | ActiveLimitError>
  readonly interrupt: (
    input: InterruptInput,
  ) => Effect.Effect<
    { readonly task: Info; readonly operation: Operation; readonly sessions: ReadonlyArray<SessionSchema.ID> },
    NotFoundError | ConflictError | ActiveLimitError
  >
  readonly completeInterrupt: (
    operationID: OperationID,
  ) => Effect.Effect<
    { readonly task: Info; readonly operation: Operation; readonly sessions: ReadonlyArray<SessionSchema.ID> },
    NotFoundError | ConflictError | ActiveLimitError
  >
  readonly cancelWithInterrupt: <E, R>(input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision?: number
    readonly interrupt: (sessions: ReadonlyArray<SessionSchema.ID>) => Effect.Effect<void, E, R>
  }) => Effect.Effect<
    { readonly task: Info; readonly sessions: ReadonlyArray<SessionSchema.ID> },
    NotFoundError | ConflictError | ActiveLimitError | E,
    R
  >
  readonly cancelRootWithInterrupt: <E, R>(input: {
    readonly rootSessionID: SessionSchema.ID
    readonly interrupt: (sessions: ReadonlyArray<SessionSchema.ID>) => Effect.Effect<void, E, R>
  }) => Effect.Effect<{ readonly sessions: ReadonlyArray<SessionSchema.ID> }, E | ConflictError | ActiveLimitError, R>
  readonly coordinateRootRemoval: <A, E, R>(input: {
    readonly rootSessionID: SessionSchema.ID
    readonly interrupt: (sessions: ReadonlyArray<SessionSchema.ID>) => Effect.Effect<void, E, R>
    readonly remove: (taskAggregateIDs: ReadonlyArray<ID>) => Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | ConflictError | ActiveLimitError, R>
  readonly settle: (input: {
    readonly taskID: ID
    readonly expectedRevision: number
    readonly status: "completed" | "failed" | "interrupted"
    readonly result?: string
    readonly error?: string
  }) => Effect.Effect<Info, NotFoundError | ConflictError | InvalidStateError | ActiveLimitError>
  readonly get: (taskID: ID) => Effect.Effect<Info | undefined>
  readonly getMany: (taskIDs: ReadonlyArray<ID>) => Effect.Effect<ReadonlyArray<Info>>
  readonly owner: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  /** Status counts for the tasks {@link list} would return, without loading them. */
  readonly counts: (input: ListInput) => Effect.Effect<Counts>
  readonly hasChildren: (parentSessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly listDirectBounded: (
    parentSessionID: SessionSchema.ID,
    limit: number,
  ) => Effect.Effect<{ readonly tasks: ReadonlyArray<Info>; readonly truncated: boolean }>
  readonly listAggregateIDs: (rootSessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<ID>>
  readonly listPage: (input: {
    readonly rootSessionID: SessionSchema.ID
    readonly after?: { readonly timeCreated: number; readonly id: ID }
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<Info>>
  readonly listActive: (rootSessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly wait: (taskIDs: ReadonlyArray<ID>) => Effect.Effect<ReadonlyArray<Info>, NotFoundError>
  /** Admit a bounded advisory update to the durable parent Session. */
  readonly notifyParent: (input: {
    readonly taskID: ID
    readonly text: string
    readonly messageID?: SessionMessage.ID
    readonly source?: SessionInput.Source
    readonly coalesce?: boolean
    readonly allowTerminal?: boolean
  }) => Effect.Effect<
    { readonly sessionID: SessionSchema.ID; readonly admitted: boolean } | undefined,
    NotFoundError | ConflictError
  >
  readonly authority: (sessionID: SessionSchema.ID) => Effect.Effect<Authority | undefined>
  readonly isTaskOwned: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly hasRootHistory: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly authorizeMutation: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID?: ID
  }) => Effect.Effect<void, OwnedSessionError>
  readonly authorizeRun: (sessionID: SessionSchema.ID) => Effect.Effect<void, OwnedSessionError>
  readonly authorizeRelocation: (sessionID: SessionSchema.ID) => Effect.Effect<void, OwnedSessionError>
  readonly settleRun: (input: {
    readonly sessionID: SessionSchema.ID
    readonly status: "completed" | "failed" | "interrupted"
    readonly error?: string
  }) => Effect.Effect<
    | {
        readonly task: Info
        readonly transitioned: boolean
        /** Child Sessions retired with this task; the drain should interrupt them. */
        readonly retired: ReadonlyArray<SessionSchema.ID>
      }
    | undefined,
    ConflictError | InvalidStateError | ActiveLimitError
  >
  readonly reconcile: () => Effect.Effect<void, NotFoundError | ConflictError | ActiveLimitError>
  /**
   * Promote the oldest queued tasks of one root while it has free active slots.
   * The caller resolves the Location-scoped `subagents.max_concurrent` value;
   * this global service cannot read it. Returns the child Session IDs the
   * caller must wake.
   */
  readonly promote: (
    rootSessionID: SessionSchema.ID,
    activeLimit: number,
  ) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  /**
   * Process-global promotion driver. Promotes every root with queued work, then
   * parks until a task changes locally or another connection commits, forever.
   * The owner of Session execution forks it and supplies the wake.
   */
  readonly runPromotion: (
    wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>,
    activeLimit: (rootSessionID: SessionSchema.ID) => Effect.Effect<number>,
  ) => Effect.Effect<never>
  /**
   * Re-admit a queued advisory for every board note still marked pending after a
   * crash and mark it delivered. Runs during layer construction; admit-only, so
   * the durable inputs promote on each parent's next drain.
   */
  readonly deliverPendingParentNotifications: () => Effect.Effect<
    void,
    NotFoundError | ConflictError | TeamBoard.Failure
  >
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionTask") {}

const terminal = new Set<Status>(["completed", "failed", "cancelled", "interrupted"])
const active = ["starting", "running"] satisfies ReadonlyArray<Status>
const unfinished = ["queued", "starting", "running"] satisfies ReadonlyArray<Status>
const cancellable = new Set<Status>([...unfinished, "interrupted"])

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const primary = isWithReplicas(database.db) ? database.db.$primary : database.db
    const events = yield* EventV2.Service
    const creation = yield* SessionCreation.Service
    const sessions = yield* SessionStore.Service
    const board = yield* TeamBoard.Service
    const actorOperations = KeyedMutex.makeUnsafe<string>()
    const roots = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const removalLeases = new Map<SessionSchema.ID, symbol>()
    const rootCancellationLeases = new Map<SessionSchema.ID, symbol>()
    const cancellationLeases = new Map<ID, symbol>()
    let taskChanged = Deferred.makeUnsafe<void>()

    const signalTaskChanged = Effect.fn("SessionTask.signalTaskChanged")(function* () {
      const changed = taskChanged
      taskChanged = Deferred.makeUnsafe<void>()
      yield* Deferred.succeed(changed, undefined)
    })

    // Local projectors signal without polling. SQLite's connection-local
    // change token covers commits made by another connection or process.
    const dataVersion = primary.get<{ data_version: number }>(sql`PRAGMA data_version`).pipe(
      Effect.orDie,
      Effect.map((row) => row?.data_version ?? 0),
    )
    const awaitExternalChange = (version: number): Effect.Effect<void> =>
      Effect.sleep(`${EXTERNAL_CHANGE_POLL_MS} millis`).pipe(
        Effect.andThen(dataVersion),
        Effect.flatMap((current) =>
          current === version ? Effect.suspend(() => awaitExternalChange(version)) : Effect.void,
        ),
      )

    const assertRootAvailable = (rootSessionID: SessionSchema.ID) =>
      removalLeases.has(rootSessionID)
        ? Effect.fail(
            new ConflictError({
              resource: rootSessionID,
              message: "Session task graph is being removed",
            }),
          )
        : rootCancellationLeases.has(rootSessionID)
          ? Effect.fail(
              new ConflictError({
                resource: rootSessionID,
                message: "Session task graph cancellation is waiting for execution to stop",
              }),
            )
          : Effect.void

    const assertTaskAvailable = Effect.fn("SessionTask.assertTaskAvailable")(function* (taskID: ID) {
      if (cancellationLeases.has(taskID))
        return yield* new ConflictError({
          resource: taskID,
          message: "Subagent cancellation is waiting for execution to stop",
        })
      const pending = yield* primary
        .select({ id: SessionTaskOperationTable.id })
        .from(SessionTaskOperationTable)
        .where(
          and(
            eq(SessionTaskOperationTable.task_id, taskID),
            eq(SessionTaskOperationTable.kind, "interrupt"),
            eq(SessionTaskOperationTable.status, "pending"),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!pending) return
      return yield* new ConflictError({
        resource: taskID,
        message: "Subagent has a durable interrupt awaiting execution settlement",
      })
    })

    const get = Effect.fn("SessionTask.get")(function* (taskID: ID) {
      const row = yield* primary
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      return row ? taskFromRow(row) : undefined
    })

    const getMany = Effect.fn("SessionTask.getMany")(function* (taskIDs: ReadonlyArray<ID>) {
      if (taskIDs.length === 0) return []
      const rows = yield* primary
        .select()
        .from(SessionTaskTable)
        .where(inArray(SessionTaskTable.id, taskIDs))
        .all()
        .pipe(Effect.orDie)
      const tasks = new Map(rows.map((row) => [row.id, taskFromRow(row)]))
      return taskIDs.flatMap((id) => {
        const task = tasks.get(id)
        return task ? [task] : []
      })
    })

    const operationByActor = Effect.fn("SessionTask.operationByActor")(function* (actor: Actor) {
      const row = yield* primary
        .select()
        .from(SessionTaskOperationTable)
        .where(
          and(
            eq(SessionTaskOperationTable.actor_session_id, actor.sessionID),
            eq(SessionTaskOperationTable.actor_assistant_message_id, actor.assistantMessageID),
            eq(SessionTaskOperationTable.actor_tool_call_id, actor.toolCallID),
            eq(SessionTaskOperationTable.actor_item, actor.item ?? -1),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (row) return operationFromRow(row)
      const claim = yield* primary
        .select({ operationID: SessionTaskActorClaimTable.operation_id })
        .from(SessionTaskActorClaimTable)
        .where(
          and(
            eq(SessionTaskActorClaimTable.actor_session_id, actor.sessionID),
            eq(SessionTaskActorClaimTable.actor_assistant_message_id, actor.assistantMessageID),
            eq(SessionTaskActorClaimTable.actor_tool_call_id, actor.toolCallID),
            eq(SessionTaskActorClaimTable.actor_item, actor.item ?? -1),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!claim) return
      return yield* new ConflictError({
        resource: actor.toolCallID,
        message: `Subagent operation actor identity is permanently claimed by ${claim.operationID}`,
      })
    })

    const operationByID = Effect.fn("SessionTask.operationByID")(function* (operationID: OperationID) {
      const row = yield* primary
        .select()
        .from(SessionTaskOperationTable)
        .where(eq(SessionTaskOperationTable.id, operationID))
        .get()
        .pipe(Effect.orDie)
      return row ? operationFromRow(row) : undefined
    })

    const pendingOperation = Effect.fn("SessionTask.pendingOperation")(function* (
      taskID: ID,
      kind: Operation["kind"],
    ) {
      const row = yield* primary
        .select()
        .from(SessionTaskOperationTable)
        .where(
          and(
            eq(SessionTaskOperationTable.task_id, taskID),
            eq(SessionTaskOperationTable.kind, kind),
            eq(SessionTaskOperationTable.status, "pending"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? operationFromRow(row) : undefined
    })

    const owner = Effect.fn("SessionTask.owner")(function* (sessionID: SessionSchema.ID) {
      const row = yield* primary
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.child_session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? taskFromRow(row) : undefined
    })

    /**
     * Resolves the placement a task event belongs to.
     *
     * This service is global, so it publishes from whatever fiber reached it,
     * and several of those fibers have no `Location.Service` in context: the
     * execution coordinator settles a finished run on its own global drain
     * fiber, and {@link reconcile} runs during layer construction. An event
     * published without a location is dropped by every per-instance subscriber,
     * which silently strands a finished subagent as running. The placement of a
     * task is a property of its root Session rather than of the publishing
     * scope, so read it from the Session instead of from ambient context. A
     * missing Session leaves the location unset and falls back to ambient.
     */
    const locate = Effect.fn("SessionTask.locate")(function* (rootSessionID: SessionSchema.ID) {
      return (yield* sessions.get(rootSessionID))?.location
    })

    const publishTask = Effect.fn("SessionTask.publishTask")(function* (task: Info, operation?: Operation) {
      const location = yield* locate(task.rootSessionID)
      yield* events
        .publish(
          SessionEvent.Task.Updated,
          {
            sessionID: task.rootSessionID,
            taskID: task.id,
            timestamp: task.time.updated,
            task,
            operation,
          },
          location ? { location } : undefined,
        )
        .pipe(Effect.catchDefect(mapProjection(task.id)))
      return (yield* get(task.id))!
    })

    const publishOperation = Effect.fn("SessionTask.publishOperation")(function* (operation: Operation) {
      const location = yield* locate(operation.rootSessionID)
      yield* events
        .publish(
          SessionEvent.Task.OperationUpdated,
          {
            sessionID: operation.rootSessionID,
            taskID: operation.taskID,
            timestamp: operation.time.updated,
            operation,
          },
          location ? { location } : undefined,
        )
        .pipe(Effect.catchDefect(mapProjection(operation.id)))
      return (yield* operationByID(operation.id))!
    })

    const assertActor = Effect.fn("SessionTask.assertActor")(function* (actor: Actor, kind: Operation["kind"]) {
      const row = yield* primary
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, actor.assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      if (row?.session_id === actor.sessionID && row.type === "assistant") {
        const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
          ...row.data,
          id: row.id,
          type: row.type,
        }).pipe(Effect.orDie)
        if (
          message.type === "assistant" &&
          message.content.some(
            (item) =>
              item.type === "tool" && item.id === actor.toolCallID && item.name === operationToolName(kind, actor),
          )
        )
          return
      }
      return yield* new ConflictError({
        resource: actor.toolCallID,
        message: "Subagent operation actor is not a recorded tool call in the parent Session",
      })
    })

    const hasPendingInput = Effect.fn("SessionTask.hasPendingInput")(function* (sessionID: SessionSchema.ID) {
      const row = yield* primary
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(
          and(
            eq(SessionInputTable.session_id, sessionID),
            isNull(SessionInputTable.promoted_seq),
            isNull(SessionInputTable.time_cancelled),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    const retireOperationInput = Effect.fn("SessionTask.retireOperationInput")(function* (
      operation: Operation,
      timestamp: DateTime.Utc,
    ) {
      if (!operation.messageID) return
      yield* primary
        .update(SessionInputTable)
        .set({ time_cancelled: DateTime.toEpochMillis(timestamp) })
        .where(and(eq(SessionInputTable.id, operation.messageID), isNull(SessionInputTable.time_cancelled)))
        .run()
        .pipe(Effect.orDie)
    })

    const assertRequest = <A extends { readonly requestHash: string }>(stored: A, requestHash: string) =>
      stored.requestHash === requestHash
        ? Effect.void
        : new ConflictError({
            resource: "id" in stored && typeof stored.id === "string" ? stored.id : requestHash,
            message: "Subagent operation identity was reused with a different request",
          })

    const currentForOperation = Effect.fn("SessionTask.currentForOperation")(function* (
      operation: Operation,
      requestHash: string,
    ) {
      yield* assertRequest(operation, requestHash)
      const task = yield* get(operation.taskID)
      if (!task) return yield* new NotFoundError({ taskID: operation.taskID })
      return { task, operation, wake: false } satisfies Prepared
    })

    const resumeSpawn = Effect.fn("SessionTask.resumeSpawn")(function* (task: Info, operation: Operation) {
      const parent = yield* sessions.get(task.parentSessionID)
      if (!parent)
        return yield* new ConflictError({
          resource: task.parentSessionID,
          message: "Subagent parent Session does not exist",
        })
      const child = yield* creation.create({
        id: task.childSessionID,
        parentID: task.parentSessionID,
        agent: task.agent,
        model: task.model,
        title: task.description,
        location: parent.location,
      })
      if (
        child.parentID !== task.parentSessionID ||
        child.location.directory !== parent.location.directory ||
        child.location.workspaceID !== parent.location.workspaceID
      )
        return yield* new ConflictError({
          resource: task.childSessionID,
          message: "Preallocated child Session identity belongs to a different placement",
        })
      const existing = yield* SessionInput.find(primary, operation.messageID!)
      if (existing) {
        if (
          !SessionInput.equivalent(existing, {
            sessionID: task.childSessionID,
            prompt: task.prompt,
            delivery: "steer",
            agent: task.agent,
            model: task.model,
          })
        )
          return yield* new ConflictError({
            resource: operation.messageID!,
            message: "Subagent prompt identity belongs to a different durable input",
          })
      } else {
        yield* SessionInput.admit(primary, events, {
          id: operation.messageID!,
          sessionID: task.childSessionID,
          prompt: task.prompt,
          delivery: "steer",
          agent: task.agent,
          model: task.model,
          kind: "prompt",
          location: child.location,
        })
      }
      const now = yield* DateTime.now
      const applied = Operation.make({
        ...operation,
        status: "applied",
        time: { ...operation.time, updated: now, completed: now },
      })
      const running = yield* update(task, "running", { operation: applied })
      return { task: running, operation: applied, wake: true } satisfies Prepared
    })

    const countActive = Effect.fn("SessionTask.countActive")(function* (rootSessionID: SessionSchema.ID) {
      return (yield* primary
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(and(eq(SessionTaskTable.root_session_id, rootSessionID), inArray(SessionTaskTable.status, active)))
        .all()
        .pipe(Effect.orDie)).length
    })

    const countStatus = Effect.fn("SessionTask.countStatus")(function* (
      rootSessionID: SessionSchema.ID,
      statuses: ReadonlyArray<Status>,
      orchestrate?: boolean,
    ) {
      const row = yield* primary
        .select({ count: sql<number>`count(*)` })
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.root_session_id, rootSessionID),
            inArray(SessionTaskTable.status, statuses),
            orchestrate === undefined ? undefined : eq(SessionTaskTable.orchestrate, orchestrate),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row?.count ?? 0
    })

    /**
     * Whether a new or queued task may take an active slot now. Orchestrators
     * are additionally held to {@link orchestratorLimit} so they can never
     * occupy every slot their own workers need.
     */
    const hasSlot = Effect.fn("SessionTask.hasSlot")(function* (
      rootSessionID: SessionSchema.ID,
      maximum: number,
      orchestrate: boolean,
    ) {
      if ((yield* countActive(rootSessionID)) >= maximum) return false
      if (!orchestrate) return true
      return (yield* countStatus(rootSessionID, active, true)) < orchestratorLimit(maximum)
    })

    const swarmBudget = Effect.fn("SessionTask.swarmBudget")(function* (rootSessionID: SessionSchema.ID) {
      const input = yield* primary
        .select({ prompt: SessionInputTable.prompt, promotedSeq: SessionInputTable.promoted_seq })
        .from(SessionInputTable)
        .where(
          and(
            eq(SessionInputTable.session_id, rootSessionID),
            eq(SessionInputTable.source, "user"),
            isNotNull(SessionInputTable.promoted_seq),
            isNull(SessionInputTable.time_cancelled),
          ),
        )
        .orderBy(desc(SessionInputTable.promoted_seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const invocation = input?.prompt.parts?.find((part) => part.synthetic && part.metadata?.forgeSwarm !== undefined)
        ?.metadata?.forgeSwarm
      if (!invocation || input.promotedSeq === null) return
      return {
        maximum: invocation.status === "ready" ? invocation.count : 0,
        promotedSeq: input.promotedSeq,
      }
    })

    /**
     * Tasks admitted under a root's current `@swarm` request. A depth-one task
     * marks admission by its own actor message; a nested worker is charged by
     * its orchestrator's actor message, which is recorded in the root Session.
     */
    const countSwarmTasks = Effect.fn("SessionTask.countSwarmTasks")(function* (
      rootSessionID: SessionSchema.ID,
      promotedSeq: number,
    ) {
      const Parent = alias(SessionTaskTable, "task_parent")
      const Marker = alias(SessionMessageTable, "task_marker")
      return (yield* primary
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .leftJoin(Parent, eq(SessionTaskTable.parent_task_id, Parent.id))
        .innerJoin(
          Marker,
          or(
            and(
              isNull(SessionTaskTable.parent_task_id),
              eq(Marker.id, SessionTaskTable.actor_assistant_message_id),
            ),
            eq(Marker.id, Parent.actor_assistant_message_id),
          ),
        )
        .where(
          and(
            eq(SessionTaskTable.root_session_id, rootSessionID),
            eq(Marker.session_id, rootSessionID),
            gt(Marker.seq, promotedSeq),
          ),
        )
        .all()
        .pipe(Effect.orDie)).length
    })

    const resumeSend = Effect.fn("SessionTask.resumeSend")(function* (operation: Operation, activeLimit?: number) {
      const task = yield* get(operation.taskID)
      if (!task) return yield* new NotFoundError({ taskID: operation.taskID })
      if (task.status === "cancelled")
        return yield* new InvalidStateError({
          taskID: task.id,
          status: task.status,
          message: "Cancelled subagents cannot be resumed",
        })
      if (task.status === "starting" || task.status === "queued")
        return yield* new InvalidStateError({
          taskID: task.id,
          status: task.status,
          message: "Subagent startup has not reached a safe prompt boundary",
        })
      // A task that settled before it ever ran has no child Session to deliver
      // input to; resuming one would fail at durable admission.
      if (terminal.has(task.status) && task.time.started === undefined)
        return yield* new InvalidStateError({
          taskID: task.id,
          status: task.status,
          message: "Subagent was interrupted before it ever started",
        })
      if (task.status !== "running") {
        const maximum = resolveActiveLimit(activeLimit)
        // Resuming a terminal task is fresh admission: an orchestrator must
        // fit under its reserved quota, not just the raw slot count.
        if (!(yield* hasSlot(task.rootSessionID, maximum, task.authority.orchestrate === true)))
          return yield* new ActiveLimitError({
            rootSessionID: task.rootSessionID,
            maximum,
            active: yield* countActive(task.rootSessionID),
          })
      }
      const location = yield* locate(task.rootSessionID)
      const existing = yield* SessionInput.find(primary, operation.messageID!)
      if (existing) {
        if (
          !SessionInput.equivalent(existing, {
            sessionID: task.childSessionID,
            prompt: operation.prompt!,
            delivery: "steer",
            agent: task.agent,
            model: task.model,
          })
        )
          return yield* new ConflictError({
            resource: operation.messageID!,
            message: "Subagent follow-up identity belongs to a different durable input",
          })
      } else {
        yield* SessionInput.admit(primary, events, {
          id: operation.messageID!,
          sessionID: task.childSessionID,
          prompt: operation.prompt!,
          delivery: "steer",
          agent: task.agent,
          model: task.model,
          kind: "prompt",
          ...(location ? { location } : {}),
        })
      }
      const now = yield* DateTime.now
      const applied = Operation.make({
        ...operation,
        status: "applied",
        time: { ...operation.time, updated: now, completed: now },
      })
      const running = yield* update(task, "running", { operation: applied })
      return { task: running, operation: applied, wake: true } satisfies Prepared
    })

    const update = Effect.fn("SessionTask.update")(function* (
      task: Info,
      status: Status,
      input?: { readonly result?: string; readonly error?: string; readonly operation?: Operation },
    ) {
      const now = yield* DateTime.now
      const published = yield* publishTask(
        Info.make({
          ...task,
          status,
          revision: task.revision + 1,
          result: input?.result,
          error: input?.error,
          time: {
            ...task.time,
            updated: now,
            started: status === "running" ? (task.time.started ?? now) : task.time.started,
            completed: terminal.has(status) ? now : undefined,
          },
        }),
        input?.operation,
      )
      // A task that reaches a terminal state before running can never replay
      // its admission; a still-pending spawn operation must settle with it or
      // an exact retry would try to resurrect startup on a settled task.
      if ((task.status === "queued" || task.status === "starting") && terminal.has(status)) {
        const operation = yield* pendingOperation(task.id, "spawn")
        if (operation)
          yield* completeOperation(
            operation,
            "failed",
            input?.error ?? "Subagent task settled before it could start",
          )
      }
      return published
    })

    const completeOperation = Effect.fn("SessionTask.completeOperation")(function* (
      operation: Operation,
      status: "applied" | "failed",
      error?: string,
    ) {
      const now = yield* DateTime.now
      return yield* publishOperation(
        Operation.make({
          ...operation,
          status,
          error,
          time: { ...operation.time, updated: now, completed: now },
        }),
      )
    })

    const descendants = Effect.fn("SessionTask.descendants")(function* (task: Info) {
      // MAX_DEPTH is two, so only an orchestrator has children and they cannot
      // have their own: one indexed level is the whole subtree. Workers come
      // first so an orchestrator never outlives the work it is waiting on.
      if (task.depth >= MAX_DEPTH) return [task]
      const children = (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.parent_task_id, task.id))
        .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.id))
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
      return [...children, task]
    })

    const cancelTree = Effect.fn("SessionTask.cancelTree")(function* (task: Info, status: "cancelled" | "interrupted") {
      const cancelled = yield* Effect.forEach(
        yield* descendants(task),
        (item) =>
          terminal.has(item.status)
            ? Effect.succeed(item)
            : update(item, status, {
                error:
                  status === "interrupted"
                    ? "Subagent execution was interrupted by process recovery and was not replayed."
                    : undefined,
              }),
        { concurrency: 1 },
      )
      return cancelled
    })

    /**
     * Settling an orchestrator retires its unfinished workers with it: a worker
     * that kept running would hold a concurrency slot while reporting to a
     * parent that can no longer observe the result. Returns the child Session
     * IDs that had started so the caller can interrupt their drains.
     */
    const settleSubtree = Effect.fn("SessionTask.settleSubtree")(function* (
      task: Info,
      status: "completed" | "failed" | "interrupted",
    ) {
      const retired = status === "interrupted" ? "interrupted" : "cancelled"
      return yield* Effect.forEach(
        yield* descendants(task),
        (item) =>
          item.id === task.id || terminal.has(item.status)
            ? Effect.succeed(undefined)
            : update(item, retired, {
                error:
                  item.status === "queued"
                    ? "Owning orchestrator finished before this queued subagent started."
                    : "Owning orchestrator settled before this subagent finished.",
              }).pipe(Effect.as(item.status === "queued" ? undefined : item.childSessionID)),
        { concurrency: 1 },
      ).pipe(Effect.map((sessions) => sessions.filter((session) => session !== undefined)))
    })

    const resumeInterrupt = Effect.fn("SessionTask.resumeInterrupt")(function* (operation: Operation) {
      const task = yield* get(operation.taskID)
      if (!task) return yield* new NotFoundError({ taskID: operation.taskID })
      const cancelled =
        task.status === "interrupted" ? [yield* update(task, "cancelled")] : yield* cancelTree(task, "cancelled")
      const applied = operation.status === "pending" ? yield* completeOperation(operation, "applied") : operation
      return {
        task: (yield* get(task.id))!,
        operation: applied,
        sessions: cancelled.map((item) => item.childSessionID),
      }
    })

    const spawn = Effect.fn("SessionTask.spawn")((input: SpawnInput) => {
      const key = actorKey(input.actor)
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const violation = spawnPersistenceViolation(input)
          if (violation)
            return yield* new ConflictError({
              resource: input.actor.toolCallID,
              message: violation,
            })
          // The owning task is read before hashing because a nested child's
          // durable authority accumulates its ancestors' permission sets, and
          // the projection verifies the hash against that durable authority.
          const parentTask = yield* owner(input.actor.sessionID)
          // Field order matches `taskFromRow`: the request hash is a JSON digest.
          const authority = Authority.make({
            parentPermissions: input.authority.parentPermissions,
            ancestorPermissionSets: parentTask
              ? [
                  ...parentTask.authority.ancestorPermissionSets,
                  parentTask.authority.parentPermissions,
                  parentTask.authority.hardPermissions,
                ]
              : input.authority.ancestorPermissionSets,
            childPermissions: input.authority.childPermissions,
            hardPermissions: input.authority.hardPermissions,
            writeRoots: input.authority.writeRoots,
            commands: input.authority.commands,
            ...(input.authority.orchestrate === true ? { orchestrate: true as const } : {}),
          })
          const requestHash = spawnRequestHash({ ...input, authority })
          const existing = yield* operationByActor(input.actor)
          if (existing) {
            yield* assertRequest(existing, requestHash)
            if (input.id && input.id !== existing.taskID)
              return yield* new ConflictError({
                resource: input.id,
                message: "Subagent task identity was reused with a different request",
              })
            if (existing.status !== "pending") return yield* currentForOperation(existing, requestHash)
            const task = yield* get(existing.taskID)
            if (!task) return yield* new NotFoundError({ taskID: existing.taskID })
            // A queued spawn is admitted and owned by promotion; a retry only reports it.
            if (task.status === "queued") return { task, operation: existing, wake: false } satisfies Prepared
            if (terminal.has(task.status))
              return yield* Effect.gen(function* () {
                yield* assertRootAvailable(task.rootSessionID)
                // Rows written before a terminal task settled its spawn can
                // still hold a pending operation; close it so the retry reports
                // the recorded outcome instead of resurrecting startup.
                const operation = yield* operationByID(existing.id)
                const settled =
                  operation?.status === "pending"
                    ? yield* completeOperation(
                        operation,
                        "failed",
                        "Subagent task settled before its spawn could run",
                      )
                    : (operation ?? existing)
                return { task, operation: settled, wake: false } satisfies Prepared
              }).pipe(roots.withLock(task.rootSessionID))
            return yield* Effect.gen(function* () {
              yield* assertRootAvailable(task.rootSessionID)
              return yield* resumeSpawn(task, existing)
            }).pipe(roots.withLock(task.rootSessionID))
          }
          yield* assertActor(input.actor, "spawn")
          const parent = yield* sessions.get(input.actor.sessionID)
          if (!parent)
            return yield* new ConflictError({
              resource: input.actor.sessionID,
              message: "Subagent parent Session does not exist",
            })
          const depth = parentTask ? parentTask.depth + 1 : 1
          if (depth > MAX_DEPTH) return yield* new DepthLimitError({ parentSessionID: parent.id, maximum: MAX_DEPTH })
          if (parentTask && parentTask.authority.orchestrate !== true)
            return yield* new OrchestrateError({
              sessionID: parent.id,
              message: "This subagent was not granted orchestrate, so it cannot spawn workers of its own",
            })
          if (authority.orchestrate === true && depth >= MAX_DEPTH)
            return yield* new OrchestrateError({
              sessionID: parent.id,
              message: "Workers of an orchestrator cannot be granted orchestrate",
            })
          if (parentTask && parentTask.status !== "running")
            return yield* new InvalidStateError({
              taskID: parentTask.id,
              status: parentTask.status,
              message: "A task-owned Session may spawn only while its owning task is running",
            })
          if (parentTask) {
            // A nested child may narrow but never widen the exact grants its
            // orchestrator was admitted with: commands are exact-string members
            // of the parent's set and each write root must sit inside one of
            // the parent's.
            const widenedCommand = authority.commands.find(
              (command) => !parentTask.authority.commands.includes(command),
            )
            if (widenedCommand !== undefined)
              return yield* new AuthorityError({
                parentTaskID: parentTask.id,
                message: `Subagent command grant exceeds its orchestrator's authority: ${widenedCommand}`,
              })
            const widenedRoot = authority.writeRoots.find(
              (root) => !parentTask.authority.writeRoots.some((allowed) => FSUtil.contains(allowed, root)),
            )
            if (widenedRoot !== undefined)
              return yield* new AuthorityError({
                parentTaskID: parentTask.id,
                message: `Subagent write root is outside its orchestrator's authority: ${widenedRoot}`,
              })
          }
          const rootSessionID = parentTask?.rootSessionID ?? parent.id
          return yield* Effect.gen(function* () {
            yield* assertRootAvailable(rootSessionID)
            // The @swarm budget is a property of the root's latest invocation
            // and covers every descendant admitted under it, not only direct
            // children of the invoking Session.
            const budget = yield* swarmBudget(rootSessionID)
            if (budget) {
              const admitted = yield* countSwarmTasks(rootSessionID, budget.promotedSeq)
              if (admitted >= budget.maximum)
                return yield* new SwarmLimitError({
                  sessionID: rootSessionID,
                  maximum: budget.maximum,
                  admitted,
                })
            }
            const maximum = resolveActiveLimit(input.activeLimit)
            if (authority.orchestrate === true && orchestratorLimit(maximum) === 0)
              return yield* new OrchestrateError({
                sessionID: parent.id,
                message: `A concurrency limit of ${maximum} leaves no slot for an orchestrator beside its workers`,
              })
            if ((yield* countStatus(rootSessionID, unfinished)) >= MAX_TASKS_PER_ROOT)
              return yield* new QueueLimitError({ rootSessionID, maximum: MAX_TASKS_PER_ROOT })
            // Capacity never fails a spawn: it queues. A spawn also queues behind
            // existing queued work so a fresh admission cannot jump the FIFO.
            const queued =
              (yield* countStatus(rootSessionID, ["queued"])) > 0 ||
              !(yield* hasSlot(rootSessionID, maximum, authority.orchestrate === true))
            const now = yield* DateTime.now
            const task = Info.make({
              id: input.id ?? ID.create(),
              rootSessionID,
              parentSessionID: parent.id,
              childSessionID: SessionSchema.ID.create(),
              parentTaskID: parentTask?.id,
              actor: input.actor,
              agent: input.agent,
              model: input.model,
              prompt: input.prompt,
              description: input.description,
              wave: input.wave,
              depth,
              status: queued ? "queued" : "starting",
              revision: 0,
              authority,
              time: { created: now, updated: now },
            })
            const operation = Operation.make({
              id: input.operationID ?? OperationID.create(),
              taskID: task.id,
              rootSessionID,
              actor: input.actor,
              kind: "spawn",
              requestHash,
              messageID: SessionMessage.ID.create(),
              prompt: input.prompt,
              status: "pending",
              time: { created: now, updated: now },
            })
            const published = yield* publishTask(task, operation)
            if (queued) return { task: published, operation, wake: false } satisfies Prepared
            return yield* resumeSpawn(published, operation)
          }).pipe(roots.withLock(rootSessionID))
        }),
      ).pipe(actorOperations.withLock(key))
    })

    const send = Effect.fn("SessionTask.send")((input: SendInput) => {
      const key = actorKey(input.actor)
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const violation = operationPersistenceViolation(input.actor, input.prompt)
          if (violation)
            return yield* new ConflictError({
              resource: input.actor.toolCallID,
              message: violation,
            })
          const requestHash = digest(["send", input.actor, input.taskID, input.prompt])
          const existing = yield* operationByActor(input.actor)
          if (existing) {
            yield* assertRequest(existing, requestHash)
            if (existing.status !== "pending") return yield* currentForOperation(existing, requestHash)
            const task = yield* get(existing.taskID)
            if (!task) return yield* new NotFoundError({ taskID: existing.taskID })
            return yield* Effect.gen(function* () {
              yield* assertRootAvailable(task.rootSessionID)
              yield* assertTaskAvailable(task.id)
              return yield* resumeSend(existing, input.activeLimit)
            }).pipe(roots.withLock(task.rootSessionID))
          }
          yield* assertActor(input.actor, "send")
          const task = yield* get(input.taskID)
          if (!task) return yield* new NotFoundError({ taskID: input.taskID })
          return yield* Effect.gen(function* () {
            yield* assertRootAvailable(task.rootSessionID)
            yield* assertTaskAvailable(task.id)
            const current = yield* get(input.taskID)
            if (!current) return yield* new NotFoundError({ taskID: input.taskID })
            const senderTask = (yield* owner(input.actor.sessionID)) ?? undefined
            const isSibling =
              senderTask !== undefined &&
              senderTask.parentSessionID === current.parentSessionID &&
              senderTask.rootSessionID === current.rootSessionID &&
              senderTask.id !== current.id
            if (current.parentSessionID !== input.actor.sessionID && !isSibling)
              return yield* new ConflictError({
                resource: current.id,
                message: "Only the durable parent Session or a sibling subagent may send work to this subagent",
              })
            if (current.status === "cancelled")
              return yield* new InvalidStateError({
                taskID: current.id,
                status: current.status,
                message: "Cancelled subagents cannot be resumed",
              })
            if (current.status === "starting" || current.status === "queued")
              return yield* new InvalidStateError({
                taskID: current.id,
                status: current.status,
                message: "Subagent startup has not reached a safe prompt boundary",
              })
            // A task that settled before it ever ran has no child Session to
            // deliver input to; resuming one would fail at durable admission.
            if (terminal.has(current.status) && current.time.started === undefined)
              return yield* new InvalidStateError({
                taskID: current.id,
                status: current.status,
                message: "Subagent was interrupted before it ever started",
              })
            if (current.status !== "running") {
              const maximum = resolveActiveLimit(input.activeLimit)
              // Resuming a terminal task is fresh admission: an orchestrator
              // must fit under its reserved quota, not just the raw slot count.
              if (!(yield* hasSlot(current.rootSessionID, maximum, current.authority.orchestrate === true)))
                return yield* new ActiveLimitError({
                  rootSessionID: current.rootSessionID,
                  maximum,
                  active: yield* countActive(current.rootSessionID),
                })
            }
            const now = yield* DateTime.now
            const operation = Operation.make({
              id: input.operationID ?? OperationID.create(),
              taskID: current.id,
              rootSessionID: current.rootSessionID,
              actor: input.actor,
              kind: "send",
              requestHash,
              messageID: SessionMessage.ID.create(),
              prompt: input.prompt,
              status: "pending",
              time: { created: now, updated: now },
            })
            yield* publishOperation(operation)
            return yield* resumeSend(operation, input.activeLimit)
          }).pipe(roots.withLock(task.rootSessionID))
        }),
      ).pipe(actorOperations.withLock(key))
    })

    const interrupt = Effect.fn("SessionTask.interrupt")((input: InterruptInput) => {
      const requestHash = digest(["interrupt", input.actor, input.taskID])
      const key = actorKey(input.actor)
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = yield* operationByActor(input.actor)
          if (existing) {
            yield* assertRequest(existing, requestHash)
            const task = yield* get(existing.taskID)
            if (!task) return yield* new NotFoundError({ taskID: existing.taskID })
            if (existing.status === "pending")
              yield* assertRootAvailable(task.rootSessionID).pipe(roots.withLock(task.rootSessionID))
            return {
              task,
              operation: existing,
              sessions: (yield* descendants(task)).map((item) => item.childSessionID),
            }
          }
          yield* assertActor(input.actor, "interrupt")
          const task = yield* get(input.taskID)
          if (!task) return yield* new NotFoundError({ taskID: input.taskID })
          if (task.parentSessionID !== input.actor.sessionID)
            return yield* new ConflictError({
              resource: task.id,
              message: "Only the durable parent Session may interrupt this subagent",
            })
          return yield* Effect.gen(function* () {
            yield* assertRootAvailable(task.rootSessionID)
            if (cancellationLeases.has(task.id))
              return yield* new ConflictError({
                resource: task.id,
                message: "Subagent cancellation is waiting for execution to stop",
              })
            // A pending interrupt whose driver died (tool fiber interrupted, or
            // its 5s stop-wait timed out and the model retried with a fresh
            // callID) has no in-process completer: the exact-actor retry that
            // could resume it is never re-issued. Adopt the orphan instead of
            // conflicting — `completeInterrupt` is operation-scoped, so any
            // caller that stops execution may commit it, and refusing here
            // wedges send/cancel/removal on this task until process restart.
            const orphaned = yield* primary
              .select()
              .from(SessionTaskOperationTable)
              .where(
                and(
                  eq(SessionTaskOperationTable.task_id, task.id),
                  eq(SessionTaskOperationTable.kind, "interrupt"),
                  eq(SessionTaskOperationTable.status, "pending"),
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (orphaned) {
              const operation = operationFromRow(orphaned)
              return {
                task,
                operation,
                sessions: (yield* descendants(task)).map((item) => item.childSessionID),
              }
            }
            const now = yield* DateTime.now
            const operation = Operation.make({
              id: input.operationID ?? OperationID.create(),
              taskID: task.id,
              rootSessionID: task.rootSessionID,
              actor: input.actor,
              kind: "interrupt",
              requestHash,
              status: "pending",
              time: { created: now, updated: now },
            })
            yield* publishOperation(operation)
            return {
              task,
              operation,
              sessions: (yield* descendants(task)).map((item) => item.childSessionID),
            }
          }).pipe(roots.withLock(task.rootSessionID))
        }),
      ).pipe(actorOperations.withLock(key))
    })

    const completeInterrupt = Effect.fn("SessionTask.completeInterrupt")(function* (operationID: OperationID) {
      const operation = yield* operationByID(operationID)
      if (!operation)
        return yield* new ConflictError({
          resource: operationID,
          message: "Subagent interrupt operation does not exist",
        })
      if (operation.kind !== "interrupt")
        return yield* new ConflictError({
          resource: operationID,
          message: "Only durable interrupt operations can complete cancellation",
        })
      const task = yield* get(operation.taskID)
      if (!task) return yield* new NotFoundError({ taskID: operation.taskID })
      return yield* Effect.gen(function* () {
        const currentOperation = yield* operationByID(operationID)
        if (!currentOperation)
          return yield* new ConflictError({
            resource: operationID,
            message: "Subagent interrupt operation disappeared before completion",
          })
        if (currentOperation.status === "pending") {
          yield* assertRootAvailable(task.rootSessionID)
          return yield* resumeInterrupt(currentOperation)
        }
        const currentTask = yield* get(currentOperation.taskID)
        if (!currentTask) return yield* new NotFoundError({ taskID: currentOperation.taskID })
        return {
          task: currentTask,
          operation: currentOperation,
          sessions: (yield* descendants(currentTask)).map((item) => item.childSessionID),
        }
      }).pipe(roots.withLock(task.rootSessionID))
    })

    const cancelWithInterrupt: Interface["cancelWithInterrupt"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const task = yield* get(input.taskID)
          if (!task) return yield* new NotFoundError({ taskID: input.taskID })
          const lease = Symbol(input.taskID)
          const prepared = yield* Effect.gen(function* () {
            yield* assertRootAvailable(task.rootSessionID)
            yield* assertTaskAvailable(task.id)
            const current = yield* get(task.id)
            if (!current) return yield* new NotFoundError({ taskID: task.id })
            if (current.rootSessionID !== input.sessionID && current.parentSessionID !== input.sessionID)
              return yield* new ConflictError({
                resource: current.id,
                message: "Session does not own this subagent task",
              })
            if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
              return yield* new ConflictError({
                resource: current.id,
                message: `Task revision conflict: expected ${input.expectedRevision}, found ${current.revision}`,
              })
            if (current.status === "interrupted") {
              const cancelled = yield* update(current, "cancelled")
              return {
                task: cancelled,
                sessions: (yield* descendants(cancelled)).map((item) => item.childSessionID),
                interrupt: false as const,
              }
            }
            if (terminal.has(current.status))
              return {
                task: current,
                sessions: (yield* descendants(current)).map((item) => item.childSessionID),
                interrupt: false as const,
              }
            cancellationLeases.set(current.id, lease)
            return {
              task: current,
              sessions: (yield* descendants(current)).map((item) => item.childSessionID),
              interrupt: true as const,
            }
          }).pipe(roots.withLock(task.rootSessionID))
          if (!prepared.interrupt) return { task: prepared.task, sessions: prepared.sessions }
          const release = roots.withLock(task.rootSessionID)(
            Effect.sync(() => {
              if (cancellationLeases.get(task.id) === lease) cancellationLeases.delete(task.id)
            }),
          )
          return yield* restore(input.interrupt(prepared.sessions)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (cancellationLeases.get(task.id) !== lease)
                  return yield* new ConflictError({
                    resource: task.id,
                    message: "Subagent cancellation lease was lost",
                  })
                const current = yield* get(task.id)
                if (!current) return yield* new NotFoundError({ taskID: task.id })
                yield* Effect.forEach(
                  yield* descendants(current),
                  (item) => (cancellable.has(item.status) ? update(item, "cancelled") : Effect.void),
                  { concurrency: 1, discard: true },
                )
                return { task: (yield* get(task.id))!, sessions: prepared.sessions }
              }).pipe(roots.withLock(task.rootSessionID)),
            ),
            Effect.ensuring(release),
          )
        }),
      )

    const activeRootTasks = Effect.fn("SessionTask.activeRootTasks")(function* (rootSessionID: SessionSchema.ID) {
      return (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(and(eq(SessionTaskTable.root_session_id, rootSessionID), inArray(SessionTaskTable.status, active)))
        .orderBy(asc(SessionTaskTable.depth), asc(SessionTaskTable.time_created))
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
    })

    const cancellableRootTasks = Effect.fn("SessionTask.cancellableRootTasks")(function* (
      rootSessionID: SessionSchema.ID,
    ) {
      return (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(
          and(
            eq(SessionTaskTable.root_session_id, rootSessionID),
            inArray(SessionTaskTable.status, [...cancellable]),
          ),
        )
        .orderBy(asc(SessionTaskTable.depth), asc(SessionTaskTable.time_created))
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
    })

    const cancelRootUnlocked = Effect.fn("SessionTask.cancelRootUnlocked")(function* (rootSessionID: SessionSchema.ID) {
      const tasks = (yield* cancellableRootTasks(rootSessionID)).toReversed()
      yield* Effect.forEach(tasks, (task) => update(task, "cancelled"), {
        concurrency: 1,
        discard: true,
      })
      return { sessions: tasks.map((task) => task.childSessionID) }
    })

    const cancelRootWithInterrupt: Interface["cancelRootWithInterrupt"] = (input) =>
      Effect.uninterruptibleMask((restore) => {
        const lease = Symbol(input.rootSessionID)
        const release = roots.withLock(input.rootSessionID)(
          Effect.sync(() => {
            if (rootCancellationLeases.get(input.rootSessionID) === lease)
              rootCancellationLeases.delete(input.rootSessionID)
          }),
        )
        return Effect.gen(function* () {
          const prepared = yield* Effect.gen(function* () {
            yield* assertRootAvailable(input.rootSessionID)
            const tasks = yield* cancellableRootTasks(input.rootSessionID)
            yield* Effect.forEach(tasks, (task) => assertTaskAvailable(task.id), { discard: true })
            if (tasks.length === 0) return { sessions: [], interrupt: false as const }
            rootCancellationLeases.set(input.rootSessionID, lease)
            return {
              sessions: tasks
                .filter((task) => active.some((status) => status === task.status))
                .toReversed()
                .map((task) => task.childSessionID),
              interrupt: true as const,
            }
          }).pipe(roots.withLock(input.rootSessionID))
          if (!prepared.interrupt) return { sessions: prepared.sessions }
          yield* restore(input.interrupt(prepared.sessions))
          return yield* Effect.gen(function* () {
            if (rootCancellationLeases.get(input.rootSessionID) !== lease)
              return yield* new ConflictError({
                resource: input.rootSessionID,
                message: "Session task graph cancellation lease was lost",
              })
            yield* cancelRootUnlocked(input.rootSessionID)
            return { sessions: prepared.sessions }
          }).pipe(roots.withLock(input.rootSessionID))
        }).pipe(Effect.ensuring(release))
      })

    const settle = Effect.fn("SessionTask.settle")(function* (input: {
      readonly taskID: ID
      readonly expectedRevision: number
      readonly status: "completed" | "failed" | "interrupted"
      readonly result?: string
      readonly error?: string
    }) {
      const task = yield* get(input.taskID)
      if (!task) return yield* new NotFoundError({ taskID: input.taskID })
      return yield* Effect.gen(function* () {
        const current = yield* get(input.taskID)
        if (!current) return yield* new NotFoundError({ taskID: input.taskID })
        if (input.result && input.result.length > MAX_RESULT_LENGTH)
          return yield* new ConflictError({
            resource: current.id,
            message: `Subagent result exceeds ${MAX_RESULT_LENGTH} characters`,
          })
        if (input.error && input.error.length > MAX_ERROR_LENGTH)
          return yield* new ConflictError({
            resource: current.id,
            message: `Subagent error exceeds ${MAX_ERROR_LENGTH} characters`,
          })
        if (current.revision !== input.expectedRevision)
          return yield* new ConflictError({
            resource: current.id,
            message: `Task revision conflict: expected ${input.expectedRevision}, found ${current.revision}`,
          })
        if (current.status !== "running")
          return yield* new InvalidStateError({
            taskID: current.id,
            status: current.status,
            message: "Only a running subagent may settle",
          })
        if (yield* hasPendingInput(current.childSessionID)) return current
        yield* settleSubtree(current, input.status)
        return yield* update(current, input.status, { result: input.result, error: input.error })
      }).pipe(roots.withLock(task.rootSessionID))
    })

    const list = Effect.fn("SessionTask.list")(function* (input: ListInput) {
      return (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(listWhere(input))
        .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.id))
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
    })

    const counts = Effect.fn("SessionTask.counts")(function* (input: ListInput) {
      const rows = yield* primary
        .select({ status: SessionTaskTable.status, count: sql<number>`count(*)` })
        .from(SessionTaskTable)
        .where(listWhere(input))
        .groupBy(SessionTaskTable.status)
        .all()
        .pipe(Effect.orDie)
      const sum = (match: (status: Status) => boolean) =>
        rows.filter((row) => match(row.status)).reduce((total, row) => total + row.count, 0)
      return {
        queued: sum((status) => status === "queued"),
        active: sum(isActive),
        terminal: sum((status) => terminal.has(status)),
      } satisfies Counts
    })

    const hasChildren = Effect.fn("SessionTask.hasChildren")(function* (parentSessionID: SessionSchema.ID) {
      return (
        (yield* primary
          .select({ id: SessionTaskTable.id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.parent_session_id, parentSessionID))
          .limit(1)
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const listDirectBounded = Effect.fn("SessionTask.listDirectBounded")(function* (
      parentSessionID: SessionSchema.ID,
      limit: number,
    ) {
      const maximum = Math.max(1, Math.trunc(limit))
      const activeRows = (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(and(eq(SessionTaskTable.parent_session_id, parentSessionID), inArray(SessionTaskTable.status, active)))
        .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.id))
        .limit(maximum + 1)
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
      const activeTasks = activeRows.slice(0, maximum)
      const remaining = maximum - activeTasks.length
      const recent =
        remaining <= 0
          ? []
          : (yield* primary
              .select()
              .from(SessionTaskTable)
              .where(
                and(
                  eq(SessionTaskTable.parent_session_id, parentSessionID),
                  notInArray(SessionTaskTable.status, active),
                ),
              )
              .orderBy(desc(SessionTaskTable.time_created), desc(SessionTaskTable.id))
              .limit(remaining + 1)
              .all()
              .pipe(Effect.orDie)).map(taskFromRow)
      return {
        tasks: [...activeTasks, ...recent.slice(0, remaining)].toSorted(
          (a, b) =>
            DateTime.toEpochMillis(a.time.created) - DateTime.toEpochMillis(b.time.created) || a.id.localeCompare(b.id),
        ),
        truncated: activeRows.length > maximum || recent.length > remaining,
      }
    })

    const listAggregateIDs = Effect.fn("SessionTask.listAggregateIDs")(function* (rootSessionID: SessionSchema.ID) {
      return (yield* primary
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.root_session_id, rootSessionID))
        .all()
        .pipe(Effect.orDie)).map((row) => row.id)
    })

    const coordinateRootRemoval: Interface["coordinateRootRemoval"] = (input) =>
      Effect.uninterruptibleMask((restore) => {
        const lease = Symbol(input.rootSessionID)
        const release = roots.withLock(input.rootSessionID)(
          Effect.sync(() => {
            if (removalLeases.get(input.rootSessionID) === lease) removalLeases.delete(input.rootSessionID)
          }),
        )
        return Effect.gen(function* () {
          const sessions = yield* Effect.gen(function* () {
            yield* assertRootAvailable(input.rootSessionID)
            const tasks = yield* cancellableRootTasks(input.rootSessionID)
            yield* Effect.forEach(tasks, (task) => assertTaskAvailable(task.id), { discard: true })
            removalLeases.set(input.rootSessionID, lease)
            return tasks
              .filter((task) => active.some((status) => status === task.status))
              .toReversed()
              .map((task) => task.childSessionID)
          }).pipe(roots.withLock(input.rootSessionID))
          yield* restore(input.interrupt(sessions))
          return yield* Effect.gen(function* () {
            if (removalLeases.get(input.rootSessionID) !== lease)
              return yield* new ConflictError({
                resource: input.rootSessionID,
                message: "Session task graph removal lease was lost",
              })
            yield* cancelRootUnlocked(input.rootSessionID)
            return yield* input.remove(yield* listAggregateIDs(input.rootSessionID))
          }).pipe(roots.withLock(input.rootSessionID))
        }).pipe(Effect.ensuring(release))
      })

    const listPage = Effect.fn("SessionTask.listPage")(function* (input: {
      readonly rootSessionID: SessionSchema.ID
      readonly after?: { readonly timeCreated: number; readonly id: ID }
      readonly limit: number
    }) {
      const after = input.after
        ? or(
            lt(SessionTaskTable.time_created, input.after.timeCreated),
            and(eq(SessionTaskTable.time_created, input.after.timeCreated), lt(SessionTaskTable.id, input.after.id)),
          )
        : undefined
      return (yield* primary
        .select()
        .from(SessionTaskTable)
        .where(and(eq(SessionTaskTable.root_session_id, input.rootSessionID), after))
        .orderBy(desc(SessionTaskTable.time_created), desc(SessionTaskTable.id))
        .limit(Math.max(1, Math.min(Math.trunc(input.limit), MAX_LIST_PAGE_LIMIT)))
        .all()
        .pipe(Effect.orDie)).map(taskFromRow)
    })

    const listActive = Effect.fn("SessionTask.listActive")(function* (rootSessionID: SessionSchema.ID) {
      return (
        (yield* primary
          .select()
          .from(SessionTaskTable)
          .where(and(eq(SessionTaskTable.root_session_id, rootSessionID), inArray(SessionTaskTable.status, active)))
          .orderBy(desc(SessionTaskTable.time_created), desc(SessionTaskTable.id))
          // The hard cap, not the configured limit: no configured value can put
          // more than this many tasks in an active state, so nothing is hidden.
          .limit(MAX_ACTIVE_PER_ROOT)
          .all()
          .pipe(Effect.orDie)).map(taskFromRow)
      )
    })

    const wait = Effect.fn("SessionTask.wait")(function* (taskIDs: ReadonlyArray<ID>) {
      if (taskIDs.length === 0) return []
      const read = Effect.gen(function* () {
        const rows = yield* primary
          .select({ id: SessionTaskTable.id, status: SessionTaskTable.status })
          .from(SessionTaskTable)
          .where(inArray(SessionTaskTable.id, taskIDs))
          .all()
          .pipe(Effect.orDie)
        const statuses = new Map(rows.map((row) => [row.id, row.status]))
        const missing = taskIDs.find((id) => !statuses.has(id))
        if (missing) return yield* new NotFoundError({ taskID: missing })
        if (
          taskIDs.some((id) => {
            const status = statuses.get(id)
            return status !== undefined && !terminal.has(status)
          })
        )
          return undefined
        const tasks = yield* getMany(taskIDs)
        const missingTask = taskIDs.find((id) => !tasks.some((task) => task.id === id))
        if (missingTask) return yield* new NotFoundError({ taskID: missingTask })
        return tasks
      })
      const awaitTerminal = (): Effect.Effect<Info[], NotFoundError> =>
        Effect.gen(function* () {
          // Capture both change tokens before reading. A transition racing the
          // read is then visible either in the snapshot or in one of the tokens.
          const localChange = taskChanged
          const version = yield* dataVersion
          const current = yield* read
          if (current) return current
          yield* Effect.race(Deferred.await(localChange), awaitExternalChange(version))
          return yield* Effect.suspend(awaitTerminal)
        })
      return yield* awaitTerminal()
    })

    const resolveNotificationID = (
      input: {
        readonly parentSessionID: SessionSchema.ID
        readonly prompt: Prompt
        readonly source?: SessionInput.Source
      },
      candidate: SessionMessage.ID,
    ): Effect.Effect<{ readonly id: SessionMessage.ID; readonly existing: boolean }, ConflictError> =>
      Effect.gen(function* () {
        const existingRow = yield* primary
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, candidate))
          .get()
          .pipe(Effect.orDie)
        if (existingRow) {
          const existing = yield* SessionInput.find(primary, candidate)
          const equivalent =
            existing !== undefined &&
            SessionInput.equivalent(existing, {
              sessionID: input.parentSessionID,
              prompt: input.prompt,
              delivery: "queue",
            }) &&
            existingRow.source === (input.source ?? "user")
          if (!equivalent)
            return yield* new ConflictError({
              resource: candidate,
              message: "Parent notification message ID conflicts with an existing input",
            })
          if (existingRow.time_cancelled === null) return { id: candidate, existing: true } as const
          if (input.source === undefined || input.source === "user" || existing === undefined)
            return yield* new ConflictError({
              resource: candidate,
              message: "Parent notification message ID refers to a cancelled input",
            })
          return yield* resolveNotificationID(
            input,
            SessionMessage.ID.make(`${candidate}_reopen_${existing.admittedSeq}`),
          )
        }

        const identity = yield* SessionInput.findIdentity(primary, candidate)
        if (!identity) return { id: candidate, existing: false } as const
        const equivalent = SessionInput.equivalentIdentity(identity, {
          kind: "prompt",
          sessionID: input.parentSessionID,
          prompt: input.prompt,
          delivery: "queue",
          source: input.source,
        })
        if (identity.state === "active" && equivalent) return { id: candidate, existing: false } as const
        if (
          identity.state === "reverted" &&
          input.source !== undefined &&
          input.source !== "user" &&
          equivalent &&
          identity.admitted
        )
          return yield* resolveNotificationID(
            input,
            SessionMessage.ID.make(`${candidate}_reopen_${identity.admitted.admittedSeq}`),
          )
        return yield* new ConflictError({
          resource: candidate,
          message: "Parent notification message ID conflicts with an existing identity",
        })
      })

    const notifyParent = Effect.fn("SessionTask.notifyParent")(
      (input: {
        readonly taskID: ID
        readonly text: string
        readonly messageID?: SessionMessage.ID
        readonly source?: SessionInput.Source
        /** Fold into an already-pending advisory of the same source. Only board digests opt in —
         *  a settle or direct advisory carries unique content that must not be dropped. */
        readonly coalesce?: boolean
        readonly allowTerminal?: boolean
      }) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const task = yield* get(input.taskID)
            if (!task) return yield* new NotFoundError({ taskID: input.taskID })
            return yield* Effect.gen(function* () {
              const current = yield* get(input.taskID)
              if (!current || (terminal.has(current.status) && input.allowTerminal !== true)) return undefined
              const parent = yield* sessions.get(current.parentSessionID)
              if (!parent)
                return yield* new ConflictError({
                  resource: current.parentSessionID,
                  message: "Subagent parent Session does not exist",
                })
              const prompt = Prompt.make({ text: input.text })
              const resolved = input.messageID
                ? yield* resolveNotificationID(
                    { parentSessionID: parent.id, prompt, source: input.source },
                    input.messageID,
                  )
                : undefined
              if (resolved?.existing) return { sessionID: parent.id, admitted: true } as const
              if (
                input.source &&
                input.coalesce === true &&
                (yield* SessionInput.hasPendingSource(primary, parent.id, input.source))
              )
                return { sessionID: parent.id, admitted: false } as const
              if (encodedBytes(prompt) > MAX_PROMPT_BYTES)
                return yield* new ConflictError({
                  resource: current.id,
                  message: `Parent update exceeds ${MAX_PROMPT_BYTES} encoded bytes`,
                })
              yield* SessionInput.admit(primary, events, {
                id: resolved?.id ?? SessionMessage.ID.create(),
                sessionID: parent.id,
                prompt,
                // Board observations must not outrank an explicit user steer.
                delivery: "queue",
                source: input.source,
                kind: "prompt",
                location: parent.location,
                ...(parent.revert ? { revert: { messageID: parent.revert.messageID } } : {}),
              })
              return { sessionID: parent.id, admitted: true } as const
            }).pipe(roots.withLock(task.rootSessionID))
          }),
        ),
    )

    const authorizeMutation = Effect.fn("SessionTask.authorizeMutation")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID?: ID
    }) {
      const task = yield* owner(input.sessionID)
      if (!task) return
      if (input.taskID === task.id && task.status === "running") return
      return yield* new OwnedSessionError({
        sessionID: input.sessionID,
        taskID: task.id,
        message: "Task-owned child Sessions reject direct mutation",
      })
    })

    const authorizeRun = Effect.fn("SessionTask.authorizeRun")(function* (sessionID: SessionSchema.ID) {
      const task = yield* owner(sessionID)
      if (!task || task.status === "running") return
      return yield* new OwnedSessionError({
        sessionID,
        taskID: task.id,
        message: `Task-owned child Session cannot run while its task is ${task.status}`,
      })
    })

    const authorizeRelocation = Effect.fn("SessionTask.authorizeRelocation")(function* (sessionID: SessionSchema.ID) {
      const owned = yield* owner(sessionID)
      if (owned)
        return yield* new OwnedSessionError({
          sessionID,
          taskID: owned.id,
          message: "Task-owned child Sessions cannot be relocated independently",
        })
      const root = yield* primary
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.root_session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!root) return
      return yield* new OwnedSessionError({
        sessionID,
        taskID: root.id,
        message: "Sessions with durable subagent history cannot be relocated without their complete task graph",
      })
    })

    const settleRun = Effect.fn("SessionTask.settleRun")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly status: "completed" | "failed" | "interrupted"
      readonly error?: string
    }) {
      const task = yield* owner(input.sessionID)
      if (!task) return
      return yield* Effect.gen(function* () {
        const current = yield* owner(input.sessionID)
        if (!current) return
        if (terminal.has(current.status)) return { task: current, transitioned: false, retired: [] }
        if (current.status !== "running")
          return yield* new InvalidStateError({
            taskID: current.id,
            status: current.status,
            message: "Only a running subagent may settle its Session drain",
          })
        if (yield* hasPendingInput(input.sessionID))
          return { task: current, transitioned: false, retired: [] }
        const row = yield* primary
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "assistant")))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        const latest = row.at(-1)
        const message = latest
          ? yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
              ...latest.data,
              id: latest.id,
              type: latest.type,
            }).pipe(Effect.orDie)
          : undefined
        const text =
          message?.type === "assistant"
            ? message.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n\n")
            : undefined
        const result =
          text && text.length > MAX_RESULT_LENGTH
            ? `${text.slice(0, MAX_RESULT_LENGTH - RESULT_TRUNCATED_SUFFIX.length)}${RESULT_TRUNCATED_SUFFIX}`
            : text
        const retired = yield* settleSubtree(current, input.status)
        return {
          task: yield* update(current, input.status, {
            result: result || undefined,
            error: input.error?.slice(0, MAX_ERROR_LENGTH),
          }),
          transitioned: true,
          retired,
        }
      }).pipe(roots.withLock(task.rootSessionID))
    })

    /**
     * Claims one queued task as `queued -> starting` before any side effect,
     * then runs the ordinary spawn startup. Returns the child Session to wake.
     */
    const promoteOne = Effect.fn("SessionTask.promoteOne")(function* (task: Info) {
      const operation = yield* pendingOperation(task.id, "spawn")
      const parentTask = task.parentTaskID ? yield* get(task.parentTaskID) : undefined
      // A pending interrupt already owns the outcome: promotion settles the
      // queued spawn as cancelled so the interrupt's completer commits the
      // recorded intent instead of starting a session that must immediately
      // die. An orchestrator that finished or stopped has nobody left to
      // report to. `update` fails the still-pending spawn operation itself.
      const interrupted = (yield* pendingOperation(task.id, "interrupt")) !== undefined
      const orphaned = parentTask !== undefined && parentTask.status !== "running"
      if (interrupted || orphaned || operation === undefined) {
        yield* update(task, "cancelled", {
          error: interrupted
            ? "Subagent was interrupted before it started."
            : orphaned
              ? "Owning orchestrator finished before this queued subagent started."
              : "Queued subagent lost its spawn operation.",
        })
        return undefined
      }
      const starting = yield* update(task, "starting")
      return yield* resumeSpawn(starting, operation).pipe(
        Effect.map((prepared) => prepared.task.childSessionID),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = `Queued subagent failed to start: ${error.message}`.slice(0, MAX_ERROR_LENGTH)
            const current = yield* get(task.id)
            if (current && !terminal.has(current.status)) yield* update(current, "failed", { error: message })
            const pending = yield* pendingOperation(task.id, "spawn")
            if (pending) yield* completeOperation(pending, "failed", message)
            return undefined
          }),
        ),
      )
    })

    const promote = Effect.fn("SessionTask.promote")(function* (
      rootSessionID: SessionSchema.ID,
      activeLimit: number,
    ) {
      // Collected outside the guarded pass so children already started still
      // get woken when a later promotion in the same pass fails.
      const woken: SessionSchema.ID[] = []
      yield* Effect.gen(function* () {
        if (removalLeases.has(rootSessionID) || rootCancellationLeases.has(rootSessionID)) return
        const maximum = resolveActiveLimit(activeLimit)
        while ((yield* countActive(rootSessionID)) < maximum) {
          const orchestrators = (yield* countStatus(rootSessionID, active, true)) < orchestratorLimit(maximum)
          const row = yield* primary
            .select()
            .from(SessionTaskTable)
            .where(
              and(
                eq(SessionTaskTable.root_session_id, rootSessionID),
                eq(SessionTaskTable.status, "queued"),
                orchestrators ? undefined : eq(SessionTaskTable.orchestrate, false),
              ),
            )
            .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.id))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const child = yield* promoteOne(taskFromRow(row))
          if (child) woken.push(child)
        }
      }).pipe(
        roots.withLock(rootSessionID),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to promote queued subagents", cause).pipe(Effect.annotateLogs({ rootSessionID })),
        ),
      )
      return woken
    })

    const runPromotion: Interface["runPromotion"] = (wake, activeLimit) =>
      Effect.forever(
        Effect.gen(function* () {
          // Capture both change tokens before reading, as `wait` does, so a
          // queued admission racing this pass wakes the next one.
          const localChange = taskChanged
          const version = yield* dataVersion
          const queuedRoots = yield* primary
            .selectDistinct({ rootSessionID: SessionTaskTable.root_session_id })
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.status, "queued"))
            .all()
            .pipe(Effect.orDie)
          yield* Effect.forEach(
            queuedRoots,
            (row) =>
              activeLimit(row.rootSessionID).pipe(
                Effect.flatMap((limit) => promote(row.rootSessionID, limit)),
                Effect.flatMap((ids) => Effect.forEach(ids, wake)),
                // A root whose configured limit cannot be resolved must not
                // stall promotion for every other root in this pass.
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logError("Subagent promotion failed for root", cause).pipe(
                        Effect.annotateLogs({ rootSessionID: row.rootSessionID }),
                      ),
                ),
              ),
            { discard: true },
          )
          yield* Effect.race(Deferred.await(localChange), awaitExternalChange(version))
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("Subagent promotion pass failed", cause).pipe(Effect.andThen(Effect.sleep("1 second"))),
          ),
        ),
      )

    const reconcile = Effect.fn("SessionTask.reconcile")(function* () {
      const pending = (yield* primary
        .select()
        .from(SessionTaskOperationTable)
        .where(eq(SessionTaskOperationTable.status, "pending"))
        .orderBy(asc(SessionTaskOperationTable.time_created))
        .all()
        .pipe(Effect.orDie)).map(operationFromRow)
      for (const operation of pending) {
        const task = yield* get(operation.taskID)
        if (!task) {
          yield* completeOperation(operation, "failed", "Owning task was missing during recovery")
          continue
        }
        if (operation.kind === "interrupt") {
          yield* resumeInterrupt(operation).pipe(roots.withLock(task.rootSessionID))
          continue
        }
        // A queued spawn never began side effects; promotion re-drives it.
        if (operation.kind === "spawn" && task.status === "queued") continue
        yield* Effect.gen(function* () {
          const current = yield* get(operation.taskID)
          const now = yield* DateTime.now
          yield* retireOperationInput(operation, now)
          // Cancelling a starting task already settles its pending spawn; only
          // close an operation that is still pending afterward.
          if (current && !terminal.has(current.status)) yield* cancelTree(current, "interrupted")
          const latest = yield* operationByID(operation.id)
          if (latest?.status === "pending")
            yield* completeOperation(
              latest,
              "failed",
              "Operation was interrupted by process recovery and was not replayed.",
            )
        }).pipe(roots.withLock(task.rootSessionID))
      }
      const unretiredInputs = yield* primary
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(and(isNull(SessionInputTable.promoted_seq), isNull(SessionInputTable.time_cancelled)))
        .all()
        .pipe(Effect.orDie)
      const appliedInputs = unretiredInputs.length
        ? yield* primary
            .select({ id: SessionInputTable.id })
            .from(SessionInputTable)
            .innerJoin(SessionTaskOperationTable, eq(SessionTaskOperationTable.message_id, SessionInputTable.id))
            .innerJoin(SessionTaskTable, eq(SessionTaskTable.id, SessionTaskOperationTable.task_id))
            .where(
              and(
                inArray(
                  SessionInputTable.id,
                  unretiredInputs.map((input) => input.id),
                ),
                eq(SessionTaskOperationTable.status, "applied"),
                inArray(SessionTaskTable.status, [...terminal]),
              ),
            )
            .all()
            .pipe(Effect.orDie)
        : []
      if (appliedInputs.length > 0) {
        yield* primary
          .update(SessionInputTable)
          .set({ time_cancelled: Date.now() })
          .where(
            inArray(
              SessionInputTable.id,
              appliedInputs.map((input) => input.id),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }
      const rows = yield* primary
        .select()
        .from(SessionTaskTable)
        .where(inArray(SessionTaskTable.status, active))
        .orderBy(asc(SessionTaskTable.time_created))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        yield* Effect.gen(function* () {
          // The snapshot predates this pass: an earlier cancelTree may already
          // have settled the task, so re-read it under the root lock rather
          // than replaying stale revisions.
          const task = yield* get(taskFromRow(row).id)
          if (!task || terminal.has(task.status)) return
          yield* cancelTree(task, "interrupted")
        }).pipe(roots.withLock(taskFromRow(row).rootSessionID))
      }
    })

    const deliverPendingParentNotifications = Effect.fn("SessionTask.deliverPendingParentNotifications")(function* () {
      for (const parentSessionID of yield* board.pendingParentSessions()) {
        for (const note of yield* board.pendingParentNotes({ parentSessionID })) {
          const task = yield* owner(note.authorSessionID)
          if (task !== undefined)
            yield* notifyParent({
              taskID: task.id,
              text: TeamBoard.parentUpdateText(note),
              messageID: TeamBoard.parentNotificationID(note),
              source: "subagent_board",
              coalesce: true,
            })
          // A fresh admit, a coalesced same-source admit, and a missing or terminal
          // task all resolve the note: the parent either holds the advisory or
          // learns the outcome from the child's final report.
          yield* board.markParentNotified(note.id)
        }
      }
    })

    const result = Service.of({
      spawn,
      send,
      interrupt,
      completeInterrupt,
      cancelWithInterrupt,
      cancelRootWithInterrupt,
      coordinateRootRemoval,
      settle,
      get,
      getMany,
      owner,
      list,
      counts,
      hasChildren,
      listDirectBounded,
      listAggregateIDs,
      listPage,
      listActive,
      wait,
      notifyParent,
      authority: Effect.fn("SessionTask.authority")(function* (sessionID) {
        return (yield* owner(sessionID))?.authority
      }),
      isTaskOwned: Effect.fn("SessionTask.isTaskOwned")(function* (sessionID) {
        return (yield* owner(sessionID)) !== undefined
      }),
      hasRootHistory: Effect.fn("SessionTask.hasRootHistory")(function* (sessionID) {
        const row = yield* primary
          .select({ id: SessionTaskTable.id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.root_session_id, sessionID))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      authorizeMutation,
      authorizeRun,
      authorizeRelocation,
      settleRun,
      reconcile,
      promote,
      runPromotion,
      deliverPendingParentNotifications,
    })

    yield* registerProjectors(primary, events, signalTaskChanged)
    yield* reconcile()
    yield* deliverPendingParentNotifications()
    return result
  }),
)

function registerProjectors(
  db: Database.Interface["db"],
  events: EventV2.Interface,
  signalTaskChanged: () => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    yield* events.project(SessionEvent.Task.Updated, (event) =>
      Effect.gen(function* () {
        if (
          event.durable?.aggregateID !== event.data.taskID ||
          event.data.taskID !== event.data.task.id ||
          event.data.sessionID !== event.data.task.rootSessionID ||
          (event.data.operation &&
            (event.data.operation.taskID !== event.data.task.id ||
              event.data.operation.rootSessionID !== event.data.task.rootSessionID))
        )
          return yield* Effect.die(
            new ProjectionConflict(event.data.taskID, "Task event envelope does not match its durable task identity"),
          )
        yield* projectTask(db, event.data.task, event.data.operation)
        // This is an advisory wake inside the event transaction. Waiters always
        // reread after commit, and a rollback merely causes one harmless reread.
        yield* signalTaskChanged()
      }),
    )
    yield* events.project(SessionEvent.Task.OperationUpdated, (event) =>
      Effect.gen(function* () {
        if (
          event.durable?.aggregateID !== event.data.taskID ||
          event.data.taskID !== event.data.operation.taskID ||
          event.data.sessionID !== event.data.operation.rootSessionID
        )
          return yield* Effect.die(
            new ProjectionConflict(
              event.data.operation.id,
              "Task operation event envelope does not match its durable task identity",
            ),
          )
        yield* projectOperation(db, event.data.operation, false)
      }),
    )
    yield* events.project(SessionEvent.Moved, (event) => assertSessionRelocationAllowed(db, event.data.sessionID))
    yield* events.project(SessionV1.Event.Updated, (event) =>
      Effect.gen(function* () {
        const current = yield* db
          .select({
            projectID: SessionTable.project_id,
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
            parentID: SessionTable.parent_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (
          !current ||
          (current.projectID === event.data.info.projectID &&
            current.directory === event.data.info.directory &&
            current.workspaceID === (event.data.info.workspaceID ?? null) &&
            current.parentID === (event.data.info.parentID ?? null))
        )
          return
        yield* assertSessionRelocationAllowed(db, event.data.sessionID)
      }),
    )
  })
}

const assertSessionRelocationAllowed = Effect.fn("SessionTask.assertSessionRelocationAllowed")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const owned = yield* db
    .select({ id: SessionTaskTable.id })
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.child_session_id, sessionID))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const root = owned
    ? undefined
    : yield* db
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.root_session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
  const task = owned ?? root
  if (!task) return
  return yield* Effect.die(
    new ProjectionConflict(
      task.id,
      "Durable task roots and children cannot be relocated without their complete task graph",
    ),
  )
})

const projectTask = Effect.fn("SessionTask.projectTask")(function* (
  db: Database.Interface["db"],
  task: Info,
  operation?: Operation,
) {
  const existing = yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.id, task.id))
    .get()
    .pipe(Effect.orDie)
  const violation = taskPersistenceViolation(task)
  if (violation) return yield* Effect.die(new ProjectionConflict(task.id, violation))
  if (!existing) {
    if (task.revision !== 0 || (task.status !== "starting" && task.status !== "queued"))
      return yield* Effect.die(
        new ProjectionConflict(task.id, "New task must begin at revision 0 in starting or queued state"),
      )
    if (
      !operation ||
      operation.kind !== "spawn" ||
      operation.status !== "pending" ||
      operation.taskID !== task.id ||
      operation.rootSessionID !== task.rootSessionID ||
      operation.actor.sessionID !== task.actor.sessionID ||
      operation.actor.assistantMessageID !== task.actor.assistantMessageID ||
      operation.actor.toolCallID !== task.actor.toolCallID ||
      digest(operation.prompt) !== digest(task.prompt) ||
      operation.requestHash !== spawnRequestHash(task)
    )
      return yield* Effect.die(
        new ProjectionConflict(task.id, "New task must include its matching pending spawn operation"),
      )
    yield* validateTaskPlacement(db, task, "absent")
    yield* assertRecordedActor(db, task.actor, operation.kind)
    // The projection guards the hard cap, not the configured policy limit. The
    // policy is enforced under the root lock in `spawn`/`send`, where the
    // configured value is known; enforcing it again here would make lowering
    // `subagents.max_concurrent` retroactively reject history recorded under a
    // higher limit. A queued task holds no slot.
    const activeCount =
      task.status === "queued"
        ? 0
        : (yield* db
            .select({ id: SessionTaskTable.id })
            .from(SessionTaskTable)
            .where(
              and(eq(SessionTaskTable.root_session_id, task.rootSessionID), inArray(SessionTaskTable.status, active)),
            )
            .all()
            .pipe(Effect.orDie)).length
    if (activeCount >= MAX_ACTIVE_PER_ROOT)
      return yield* Effect.die(
        new ActiveLimitError({ rootSessionID: task.rootSessionID, maximum: MAX_ACTIVE_PER_ROOT, active: activeCount }),
      )
    yield* db.insert(SessionTaskTable).values(taskRow(task)).run().pipe(Effect.orDie)
  } else {
    const previous = taskFromRow(existing)
    if (!sameIdentity(previous, task))
      return yield* Effect.die(new ProjectionConflict(task.id, "Task immutable identity changed"))
    if (task.revision !== previous.revision + 1)
      return yield* Effect.die(
        new ProjectionConflict(task.id, `Expected task revision ${previous.revision + 1}, got ${task.revision}`),
      )
    if (!allowedTransition(previous.status, task.status))
      return yield* Effect.die(
        new ProjectionConflict(task.id, `Invalid task transition ${previous.status} -> ${task.status}`),
      )
    yield* validateTaskTransition(db, previous, task, operation)
    if (!isActive(previous.status) && isActive(task.status)) {
      const activeCount = (yield* db
        .select({ id: SessionTaskTable.id })
        .from(SessionTaskTable)
        .where(and(eq(SessionTaskTable.root_session_id, task.rootSessionID), inArray(SessionTaskTable.status, active)))
        .all()
        .pipe(Effect.orDie)).length
      if (activeCount >= MAX_ACTIVE_PER_ROOT)
        return yield* Effect.die(
          new ActiveLimitError({
            rootSessionID: task.rootSessionID,
            maximum: MAX_ACTIVE_PER_ROOT,
            active: activeCount,
          }),
        )
    }
    yield* validateTaskPlacement(
      db,
      task,
      // Startup creates the child Session only as the task goes running, so a
      // task that never reached running has none: it may be queued or
      // starting, or interrupted out of either state before startup finished.
      task.time.started === undefined ? "optional" : "required",
    )
    const updated = yield* db
      .update(SessionTaskTable)
      .set(taskRow(task))
      .where(and(eq(SessionTaskTable.id, task.id), eq(SessionTaskTable.revision, previous.revision)))
      .returning({ id: SessionTaskTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated)
      return yield* Effect.die(
        new ProjectionConflict(task.id, `Task revision ${previous.revision} was concurrently replaced`),
      )
  }
  if (task.status === "cancelled" || task.status === "interrupted")
    yield* db
      .update(SessionInputTable)
      .set({ time_cancelled: DateTime.toEpochMillis(task.time.updated) })
      .where(and(eq(SessionInputTable.session_id, task.childSessionID), isNull(SessionInputTable.time_cancelled)))
      .run()
      .pipe(Effect.orDie)
  if (operation) yield* projectOperation(db, operation, true, task)
})

const projectOperation = Effect.fn("SessionTask.projectOperation")(function* (
  db: Database.Interface["db"],
  operation: Operation,
  allowSpawn: boolean,
  projectedTask?: Info,
) {
  const existing = yield* db
    .select()
    .from(SessionTaskOperationTable)
    .where(eq(SessionTaskOperationTable.id, operation.id))
    .get()
    .pipe(Effect.orDie)
  const violation = operationPersistenceViolation(
    operation.actor,
    operation.prompt,
    operation.error,
    operation.requestHash,
  )
  if (violation) return yield* Effect.die(new ProjectionConflict(operation.id, violation))
  if (!existing) {
    if (operation.status !== "pending")
      return yield* Effect.die(new ProjectionConflict(operation.id, "New task operation must begin pending"))
    if (operation.kind === "spawn" && !allowSpawn)
      return yield* Effect.die(
        new ProjectionConflict(operation.id, "Spawn operations must be committed with their new task"),
      )
    const task = yield* db
      .select()
      .from(SessionTaskTable)
      .where(eq(SessionTaskTable.id, operation.taskID))
      .get()
      .pipe(Effect.orDie)
    const actorTask = yield* db
      .select()
      .from(SessionTaskTable)
      .where(eq(SessionTaskTable.child_session_id, operation.actor.sessionID))
      .get()
      .pipe(Effect.orDie)
    const isSiblingActor =
      actorTask !== undefined &&
      actorTask.id !== task?.id &&
      actorTask.parent_session_id === task?.parent_session_id &&
      actorTask.root_session_id === task?.root_session_id
    if (
      !task ||
      task.root_session_id !== operation.rootSessionID ||
      (task.parent_session_id !== operation.actor.sessionID && !isSiblingActor)
    )
      return yield* Effect.die(
        new ProjectionConflict(operation.id, "Task operation root, owner, or parent relationship is invalid"),
      )
    const current = taskFromRow(task)
    const requestHash =
      operation.kind === "spawn"
        ? projectedTask
          ? spawnRequestHash(projectedTask)
          : undefined
        : operationRequestHash(operation)
    if (
      !requestHash ||
      operation.requestHash !== requestHash ||
      (operation.kind === "spawn" &&
        (!projectedTask ||
          projectedTask.id !== current.id ||
          digest(operation.prompt) !== digest(projectedTask.prompt)))
    )
      return yield* Effect.die(
        new ProjectionConflict(operation.id, "Task operation request hash or spawn payload is invalid"),
      )
    if (
      (operation.kind === "interrupt" && (operation.messageID !== undefined || operation.prompt !== undefined)) ||
      (operation.kind !== "interrupt" && (operation.messageID === undefined || operation.prompt === undefined))
    )
      return yield* Effect.die(
        new ProjectionConflict(operation.id, "Task operation payload does not match its operation kind"),
      )
    yield* assertRecordedActor(db, operation.actor, operation.kind)
    const claim = yield* db
      .select()
      .from(SessionTaskActorClaimTable)
      .where(
        and(
          eq(SessionTaskActorClaimTable.actor_session_id, operation.actor.sessionID),
          eq(SessionTaskActorClaimTable.actor_assistant_message_id, operation.actor.assistantMessageID),
          eq(SessionTaskActorClaimTable.actor_tool_call_id, operation.actor.toolCallID),
          eq(SessionTaskActorClaimTable.actor_item, operation.actor.item ?? -1),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (claim)
      return yield* Effect.die(
        new ProjectionConflict(operation.id, `Task actor identity is already claimed by ${claim.operation_id}`),
      )
    yield* db
      .insert(SessionTaskActorClaimTable)
      .values({
        id: operation.id,
        actor_session_id: operation.actor.sessionID,
        actor_assistant_message_id: operation.actor.assistantMessageID,
        actor_tool_call_id: operation.actor.toolCallID,
        actor_item: operation.actor.item ?? -1,
        operation_id: operation.id,
        task_id: operation.taskID,
        kind: operation.kind,
        request_hash: operation.requestHash,
        time_created: DateTime.toEpochMillis(operation.time.created),
      })
      .run()
      .pipe(Effect.orDie)
    yield* db.insert(SessionTaskOperationTable).values(operationRow(operation)).run().pipe(Effect.orDie)
    return
  }
  const previous = operationFromRow(existing)
  if (
    previous.taskID !== operation.taskID ||
    previous.rootSessionID !== operation.rootSessionID ||
    previous.actor.sessionID !== operation.actor.sessionID ||
    previous.actor.assistantMessageID !== operation.actor.assistantMessageID ||
    previous.actor.toolCallID !== operation.actor.toolCallID ||
    previous.actor.item !== operation.actor.item ||
    previous.kind !== operation.kind ||
    previous.requestHash !== operation.requestHash ||
    previous.messageID !== operation.messageID ||
    digest(previous.prompt) !== digest(operation.prompt)
  )
    return yield* Effect.die(new ProjectionConflict(operation.id, "Task operation immutable identity changed"))
  if (previous.status !== "pending" || (operation.status !== "applied" && operation.status !== "failed"))
    return yield* Effect.die(
      new ProjectionConflict(operation.id, `Invalid operation transition ${previous.status} -> ${operation.status}`),
    )
  const updated = yield* db
    .update(SessionTaskOperationTable)
    .set(operationRow(operation))
    .where(and(eq(SessionTaskOperationTable.id, operation.id), eq(SessionTaskOperationTable.status, previous.status)))
    .returning({ id: SessionTaskOperationTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated)
    return yield* Effect.die(new ProjectionConflict(operation.id, "Task operation was concurrently completed"))
})

const validateTaskPlacement = Effect.fn("SessionTask.validateTaskPlacement")(function* (
  db: Database.Interface["db"],
  task: Info,
  childMode: "absent" | "optional" | "required",
) {
  if (task.actor.sessionID !== task.parentSessionID)
    return yield* Effect.die(new ProjectionConflict(task.id, "Task actor must belong to its parent Session"))
  if (task.depth < 1 || task.depth > MAX_DEPTH)
    return yield* Effect.die(new ProjectionConflict(task.id, `Task depth ${task.depth} is outside the supported range`))
  const rows = yield* db
    .select()
    .from(SessionTable)
    .where(inArray(SessionTable.id, [task.rootSessionID, task.parentSessionID, task.childSessionID]))
    .all()
    .pipe(Effect.orDie)
  const root = rows.find((row) => row.id === task.rootSessionID)
  const parent = rows.find((row) => row.id === task.parentSessionID)
  const child = rows.find((row) => row.id === task.childSessionID)
  if (!root || !parent)
    return yield* Effect.die(new ProjectionConflict(task.id, "Task root or parent Session does not exist"))
  if (task.depth === 1 && (task.parentTaskID !== undefined || task.parentSessionID !== task.rootSessionID))
    return yield* Effect.die(
      new ProjectionConflict(task.id, "Depth-one task must be owned directly by its root Session"),
    )
  if (task.depth > 1) {
    if (!task.parentTaskID)
      return yield* Effect.die(new ProjectionConflict(task.id, "Nested task is missing its parent task identity"))
    const parentTask = yield* db
      .select()
      .from(SessionTaskTable)
      .where(eq(SessionTaskTable.id, task.parentTaskID))
      .get()
      .pipe(Effect.orDie)
    if (
      !parentTask ||
      parentTask.child_session_id !== task.parentSessionID ||
      parentTask.root_session_id !== task.rootSessionID ||
      parentTask.depth + 1 !== task.depth
    )
      return yield* Effect.die(new ProjectionConflict(task.id, "Nested task ancestry is invalid"))
  }
  if (childMode === "absent") {
    if (child)
      return yield* Effect.die(
        new ProjectionConflict(task.id, "Starting task child Session identity is already in use"),
      )
    return
  }
  if (childMode === "optional" && !child) return
  // Placement is the directory and workspace, not `project_id`. A project id is
  // derived from the git remote, so renaming or repointing a repository re-keys
  // every project in that directory. Comparing it here made a legitimate remote
  // change replay as a permanent projection conflict, which kills the process
  // that is rebuilding this table and leaves the app unable to boot.
  if (
    !child ||
    child.parent_id !== task.parentSessionID ||
    child.directory !== parent.directory ||
    child.workspace_id !== parent.workspace_id
  )
    return yield* Effect.die(new ProjectionConflict(task.id, "Task child Session placement does not match its parent"))
})

const validateTaskTransition = Effect.fn("SessionTask.validateTaskTransition")(function* (
  db: Database.Interface["db"],
  previous: Info,
  task: Info,
  operation?: Operation,
) {
  const activation =
    task.status === "running"
      ? previous.status === "starting"
        ? "spawn"
        : previous.status === "running" || terminal.has(previous.status)
          ? "send"
          : undefined
      : undefined
  if (activation) {
    if (
      !operation ||
      operation.kind !== activation ||
      operation.status !== "applied" ||
      operation.taskID !== task.id ||
      operation.rootSessionID !== task.rootSessionID
    )
      return yield* Effect.die(
        new ProjectionConflict(
          task.id,
          `Task transition ${previous.status} -> running requires an applied ${activation}`,
        ),
      )
  } else if (operation) {
    return yield* Effect.die(
      new ProjectionConflict(task.id, `Task transition ${previous.status} -> ${task.status} cannot carry an operation`),
    )
  }
  if (task.status !== "completed" && task.status !== "failed") return
  const pending = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, task.childSessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.time_cancelled),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (pending)
    return yield* Effect.die(
      new ProjectionConflict(task.id, `Task cannot enter ${task.status} while durable input is pending`),
    )
})

const assertRecordedActor = Effect.fn("SessionTask.assertRecordedActor")(function* (
  db: Database.Interface["db"],
  actor: Actor,
  kind: Operation["kind"],
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, actor.assistantMessageID))
    .get()
    .pipe(Effect.orDie)
  if (row?.session_id !== actor.sessionID || row.type !== "assistant")
    return yield* Effect.die(new ProjectionConflict(actor.toolCallID, "Task actor assistant message is invalid"))
  const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
    ...row.data,
    id: row.id,
    type: row.type,
  }).pipe(
    Effect.mapError(() => new ProjectionConflict(actor.toolCallID, "Task actor assistant message cannot be decoded")),
    Effect.orDie,
  )
  if (
    message.type === "assistant" &&
    message.content.some(
      (item) => item.type === "tool" && item.id === actor.toolCallID && item.name === operationToolName(kind, actor),
    )
  )
    return
  return yield* Effect.die(
    new ProjectionConflict(
      actor.toolCallID,
      `Task actor tool call is not recorded as ${operationToolName(kind, actor)}`,
    ),
  )
})

function taskFromRow(row: typeof SessionTaskTable.$inferSelect): Info {
  return Info.make({
    id: ID.make(row.id),
    rootSessionID: SessionSchema.ID.make(row.root_session_id),
    parentSessionID: SessionSchema.ID.make(row.parent_session_id),
    childSessionID: SessionSchema.ID.make(row.child_session_id),
    parentTaskID: row.parent_task_id ? ID.make(row.parent_task_id) : undefined,
    actor: actorFromRow(row),
    agent: AgentV2.ID.make(row.agent.slice(0, MAX_AGENT_ID_LENGTH)),
    model: row.model
      ? ModelV2.Ref.make({
          id: ModelV2.ID.make(row.model.id.slice(0, MAX_MODEL_ID_LENGTH)),
          providerID: ProviderV2.ID.make(row.model.providerID.slice(0, MAX_PROVIDER_ID_LENGTH)),
          variant: row.model.variant
            ? ModelV2.VariantID.make(row.model.variant.slice(0, MAX_VARIANT_ID_LENGTH))
            : undefined,
        })
      : undefined,
    prompt: Prompt.make(row.prompt),
    description: row.description,
    wave: row.wave ?? undefined,
    depth: row.depth,
    status: row.status,
    revision: row.revision,
    authority: Authority.make({
      parentPermissions: row.parent_permissions,
      ancestorPermissionSets: row.ancestor_permission_sets,
      childPermissions: row.child_permissions,
      hardPermissions: row.hard_permissions,
      writeRoots: row.write_roots.map((root) => AbsolutePath.make(root)),
      commands: row.commands,
      // Absent rather than false keeps request hashes of pre-fleet tasks stable.
      ...(row.orchestrate ? { orchestrate: true as const } : {}),
    }),
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      started: row.time_started === null ? undefined : DateTime.makeUnsafe(row.time_started),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })
}

function taskRow(task: Info): typeof SessionTaskTable.$inferInsert {
  return {
    id: task.id,
    root_session_id: task.rootSessionID,
    parent_session_id: task.parentSessionID,
    child_session_id: task.childSessionID,
    parent_task_id: task.parentTaskID,
    actor_session_id: task.actor.sessionID,
    actor_assistant_message_id: task.actor.assistantMessageID,
    actor_tool_call_id: task.actor.toolCallID,
    actor_item: task.actor.item ?? -1,
    agent: task.agent,
    model: task.model,
    prompt: task.prompt,
    description: task.description,
    wave: task.wave ?? null,
    depth: task.depth,
    status: task.status,
    revision: task.revision,
    parent_permissions: [...task.authority.parentPermissions],
    ancestor_permission_sets: task.authority.ancestorPermissionSets.map((rules) => [...rules]),
    child_permissions: [...task.authority.childPermissions],
    hard_permissions: [...task.authority.hardPermissions],
    write_roots: [...task.authority.writeRoots],
    commands: [...task.authority.commands],
    orchestrate: task.authority.orchestrate === true,
    result: task.result ?? null,
    error: task.error ?? null,
    time_created: DateTime.toEpochMillis(task.time.created),
    time_updated: DateTime.toEpochMillis(task.time.updated),
    time_started: task.time.started ? DateTime.toEpochMillis(task.time.started) : undefined,
    time_completed: task.time.completed ? DateTime.toEpochMillis(task.time.completed) : null,
  }
}

function operationFromRow(row: typeof SessionTaskOperationTable.$inferSelect): Operation {
  return Operation.make({
    id: OperationID.make(row.id),
    taskID: ID.make(row.task_id),
    rootSessionID: SessionSchema.ID.make(row.root_session_id),
    actor: actorFromRow(row),
    kind: row.kind,
    requestHash: row.request_hash,
    messageID: row.message_id ? SessionMessage.ID.make(row.message_id) : undefined,
    prompt: row.prompt ? Prompt.make(row.prompt) : undefined,
    status: row.status,
    error: row.error ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })
}

function operationRow(operation: Operation): typeof SessionTaskOperationTable.$inferInsert {
  return {
    id: operation.id,
    task_id: operation.taskID,
    root_session_id: operation.rootSessionID,
    actor_session_id: operation.actor.sessionID,
    actor_assistant_message_id: operation.actor.assistantMessageID,
    actor_tool_call_id: operation.actor.toolCallID,
    actor_item: operation.actor.item ?? -1,
    kind: operation.kind,
    request_hash: operation.requestHash,
    message_id: operation.messageID,
    prompt: operation.prompt,
    status: operation.status,
    error: operation.error,
    time_created: DateTime.toEpochMillis(operation.time.created),
    time_updated: DateTime.toEpochMillis(operation.time.updated),
    time_completed: operation.time.completed ? DateTime.toEpochMillis(operation.time.completed) : undefined,
  }
}

function sameIdentity(previous: Info, next: Info) {
  return (
    previous.rootSessionID === next.rootSessionID &&
    previous.parentSessionID === next.parentSessionID &&
    previous.childSessionID === next.childSessionID &&
    previous.parentTaskID === next.parentTaskID &&
    previous.actor.sessionID === next.actor.sessionID &&
    previous.actor.assistantMessageID === next.actor.assistantMessageID &&
    previous.actor.toolCallID === next.actor.toolCallID &&
    previous.actor.item === next.actor.item &&
    previous.agent === next.agent &&
    digest(previous.model) === digest(next.model) &&
    digest(previous.prompt) === digest(next.prompt) &&
    previous.description === next.description &&
    previous.wave === next.wave &&
    previous.depth === next.depth &&
    digest(previous.authority) === digest(next.authority)
  )
}

function allowedTransition(previous: Status, next: Status) {
  if (previous === "queued") return next === "starting" || next === "cancelled" || next === "interrupted"
  if (previous === "starting") return next === "running" || terminal.has(next)
  if (previous === "running") return next === "running" || terminal.has(next)
  if (previous === "cancelled") return false
  return next === "running" || next === "cancelled"
}

function actorKey(actor: Actor) {
  return `${actor.sessionID}\0${actor.assistantMessageID}\0${actor.toolCallID}\0${actor.item ?? -1}`
}

function actorFromRow(row: {
  readonly actor_session_id: string
  readonly actor_assistant_message_id: string
  readonly actor_tool_call_id: string
  readonly actor_item: number
}) {
  return Actor.make({
    sessionID: SessionSchema.ID.make(row.actor_session_id),
    assistantMessageID: SessionMessage.ID.make(row.actor_assistant_message_id),
    toolCallID: row.actor_tool_call_id,
    ...(row.actor_item >= 0 ? { item: row.actor_item } : {}),
  })
}

function operationToolName(kind: Operation["kind"], actor: Actor) {
  // A batch element spawns through `spawn_agents`; batched send and interrupt
  // operations keep their single-operation tool names.
  if (kind === "spawn") return actor.item === undefined ? "spawn_agent" : "spawn_agents"
  if (kind === "send") return "send_agent"
  return "interrupt_agent"
}

function spawnPersistenceViolation(
  input: Pick<SpawnInput, "actor" | "agent" | "model" | "description" | "prompt" | "authority" | "wave">,
) {
  if (input.actor.item !== undefined && input.actor.item >= MAX_SPAWN_BATCH)
    return `Subagent batch item index must be less than ${MAX_SPAWN_BATCH}`
  if (input.description.length > MAX_DESCRIPTION_LENGTH)
    return `Subagent description exceeds ${MAX_DESCRIPTION_LENGTH} characters`
  if (input.wave !== undefined && (input.wave.length === 0 || input.wave.length > MAX_WAVE_NAME_LENGTH))
    return `Subagent wave must be 1 to ${MAX_WAVE_NAME_LENGTH} characters`
  if (input.agent.length > MAX_AGENT_ID_LENGTH)
    return `Subagent agent identity exceeds ${MAX_AGENT_ID_LENGTH} characters`
  if (input.model?.id && input.model.id.length > MAX_MODEL_ID_LENGTH)
    return `Subagent model identity exceeds ${MAX_MODEL_ID_LENGTH} characters`
  if (input.model?.providerID && input.model.providerID.length > MAX_PROVIDER_ID_LENGTH)
    return `Subagent model provider identity exceeds ${MAX_PROVIDER_ID_LENGTH} characters`
  if (input.model?.variant && input.model.variant.length > MAX_VARIANT_ID_LENGTH)
    return `Subagent model variant identity exceeds ${MAX_VARIANT_ID_LENGTH} characters`
  if (encodedBytes(input.authority) > MAX_AUTHORITY_BYTES)
    return `Subagent authority exceeds ${MAX_AUTHORITY_BYTES} encoded bytes`
  return operationPersistenceViolation(input.actor, input.prompt)
}

function taskPersistenceViolation(task: Info) {
  const input = spawnPersistenceViolation(task)
  if (input) return input
  if (task.result && task.result.length > MAX_RESULT_LENGTH)
    return `Subagent result exceeds ${MAX_RESULT_LENGTH} characters`
  if (task.error && task.error.length > MAX_ERROR_LENGTH) return `Subagent error exceeds ${MAX_ERROR_LENGTH} characters`
}

function operationPersistenceViolation(actor: Actor, prompt?: Prompt, error?: string, requestHash?: string) {
  if (actor.toolCallID.length > MAX_TOOL_CALL_ID_LENGTH)
    return `Subagent tool call identity exceeds ${MAX_TOOL_CALL_ID_LENGTH} characters`
  if (requestHash && !new RegExp(`^[0-9a-f]{${REQUEST_HASH_LENGTH}}$`).test(requestHash))
    return `Subagent request hash must be ${REQUEST_HASH_LENGTH} lowercase hexadecimal characters`
  if (prompt && encodedBytes(prompt) > MAX_PROMPT_BYTES)
    return `Subagent prompt exceeds ${MAX_PROMPT_BYTES} encoded bytes`
  if (error && error.length > MAX_ERROR_LENGTH) return `Subagent operation error exceeds ${MAX_ERROR_LENGTH} characters`
}

function encodedBytes(input: unknown) {
  const json = JSON.stringify(input)
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8")
}

function digest(input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(input) ?? "undefined")
    .digest("hex")
}

function spawnRequestHash(
  task: Pick<Info, "actor" | "agent" | "model" | "prompt" | "description" | "authority" | "wave">,
) {
  // The wave joins the hash only when present so pre-fleet request hashes still verify.
  return digest([
    "spawn",
    task.actor,
    task.agent,
    task.model,
    task.prompt,
    task.description,
    task.authority,
    ...(task.wave === undefined ? [] : [task.wave]),
  ])
}

function operationRequestHash(operation: Operation) {
  if (operation.kind === "send")
    return operation.prompt ? digest(["send", operation.actor, operation.taskID, operation.prompt]) : undefined
  if (operation.kind === "interrupt")
    return operation.prompt === undefined && operation.messageID === undefined
      ? digest(["interrupt", operation.actor, operation.taskID])
      : undefined
}

function isActive(status: Status): status is (typeof active)[number] {
  return status === "starting" || status === "running"
}

function listWhere(input: ListInput) {
  return and(
    input.rootSessionID === undefined ? undefined : eq(SessionTaskTable.root_session_id, input.rootSessionID),
    input.parentSessionID === undefined ? undefined : eq(SessionTaskTable.parent_session_id, input.parentSessionID),
    input.wave === undefined ? undefined : eq(SessionTaskTable.wave, input.wave),
    input.statuses?.length ? inArray(SessionTaskTable.status, input.statuses) : undefined,
  )
}

function mapProjection(resource: string) {
  return (defect: unknown): Effect.Effect<never, ConflictError | ActiveLimitError> => {
    if (defect instanceof ProjectionConflict)
      return Effect.fail(new ConflictError({ resource: defect.resource, message: defect.message }))
    if (defect instanceof ActiveLimitError) return Effect.fail(defect)
    return Effect.die(defect)
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Database.node, EventV2.node, SessionCreation.node, SessionStore.node, TeamBoard.node],
})
