export * as SessionProjector from "./projector"

import { and, desc, eq, gt, inArray, isNotNull, or, sql, type AnyColumn } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { SessionRevert } from "./revert"
import { SessionStatus } from "./status"
import { WorkspaceV2 } from "../workspace"
import { ProviderV2 } from "../provider"
import { SessionContextEpoch } from "./context-epoch"
import { ToolExecutionTable } from "../tool/execution.sql"
import type { SessionSchema } from "./schema"
import {
  MessageTable,
  PartTable,
  ProviderUsageTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"
import type { DeepMutable } from "../schema"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

/**
 * The session roll-up entry for a settled V2 turn.
 *
 * `billed`, not `tokens`. The two are equal for every provider where one Turen
 * turn is one provider request, and they differ for the transports that loop
 * internally -- there `tokens` is only the final round trip, so rolling it up
 * would bill a whole Claude Code run at the price of its last request. `tokens`
 * is context occupancy and belongs to a single message, which is exactly where
 * the message projection already puts it; a cumulative column is the one place
 * it must never land.
 */
function stepUsage(data: (typeof SessionEvent.Step.Ended.Type)["data"]): Usage {
  return { cost: data.cost, tokens: data.billed ?? data.tokens }
}

const durableType = (definition: { readonly type: string; readonly durable?: { readonly version: number } }) => {
  const version = definition.durable?.version
  // Loud at module load rather than a silently wrong type string at revert time.
  if (version === undefined) throw new Error(`Event ${definition.type} is not durable`)
  return EventV2.versionedType(definition.type, version)
}

const StepEndedType = durableType(SessionEvent.Step.Ended)
const StepStartedType = durableType(SessionEvent.Step.Started)

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/**
 * Reads a stored `Step.Ended` payload structurally instead of decoding it.
 *
 * A revert must not be able to die on a historical row whose shape has since
 * moved -- the alternative to a missing field here is a session that can never
 * be reverted again. Mirrors `usage` above, which reads V1 part rows the same
 * way and for the same reason.
 */
function storedStepUsage(data: Record<string, unknown>): {
  readonly assistantMessageID: string
  readonly usage: Usage
} {
  const tokens = (value: unknown) => {
    const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
    const cache = (typeof record.cache === "object" && record.cache !== null ? record.cache : {}) as Record<
      string,
      unknown
    >
    return {
      input: finite(record.input),
      output: finite(record.output),
      reasoning: finite(record.reasoning),
      cache: { read: finite(cache.read), write: finite(cache.write) },
    }
  }
  return {
    assistantMessageID: typeof data.assistantMessageID === "string" ? data.assistantMessageID : "",
    // Same `billed ?? tokens` rule as the roll-up that added it, so what comes
    // off is exactly what went on.
    usage: { cost: finite(data.cost), tokens: tokens(data.billed ?? data.tokens) },
  }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    // Explicit null, not undefined: drizzle drops undefined columns from an
    // UPDATE SET, so unarchiving (archived cleared on the merged info) would
    // leave the old timestamp in place and silently do nothing. `revert` above
    // uses the same null-to-clear form for the same reason.
    time_archived: info.time.archived ?? null,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  // Floored at zero. A session that has spent money can never owe negative
  // money, so any arithmetic that would go under -- a transcript adopted or
  // forked with usage its new session never accrued, then reverted -- shows as
  // nothing spent rather than as a negative that propagates into `forge stats`.
  const add = (column: AnyColumn, delta: number) => sql`max(0, ${column} + ${delta * sign})`
  return db
    .update(SessionTable)
    .set({
      cost: add(SessionTable.cost, value.cost),
      tokens_input: add(SessionTable.tokens_input, value.tokens.input),
      tokens_output: add(SessionTable.tokens_output, value.tokens.output),
      tokens_reasoning: add(SessionTable.tokens_reasoning, value.tokens.reasoning),
      tokens_cache_read: add(SessionTable.tokens_cache_read, value.tokens.cache.read),
      tokens_cache_write: add(SessionTable.tokens_cache_write, value.tokens.cache.write),
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

/**
 * The per-provider half of the same roll-up, one row per settled turn.
 *
 * Reads `stepUsage` rather than the event's own `tokens` for the reason that
 * helper documents: what is reported as spend has to be what was billed. The
 * row is keyed by the turn's assistant message, so re-projecting a durable
 * event lands on the same key instead of adding a second row.
 */
const recordProviderUsage = Effect.fnUntraced(function* (
  db: DatabaseService,
  data: (typeof SessionEvent.Step.Ended.Type)["data"],
) {
  const providerID = data.model?.providerID ?? (yield* providerForEndedStep(db, data))
  if (!providerID) return
  const value = stepUsage(data)
  const row = {
    session_id: data.sessionID,
    assistant_message_id: data.assistantMessageID,
    provider_id: providerID,
    time: DateTime.toEpochMillis(data.timestamp),
    cost: value.cost,
    tokens_input: value.tokens.input,
    tokens_output: value.tokens.output,
    tokens_reasoning: value.tokens.reasoning,
    tokens_cache_read: value.tokens.cache.read,
    tokens_cache_write: value.tokens.cache.write,
  }
  yield* db
    .insert(ProviderUsageTable)
    .values(row)
    .onConflictDoUpdate({
      target: [ProviderUsageTable.session_id, ProviderUsageTable.assistant_message_id],
      set: row,
    })
    .run()
    .pipe(Effect.orDie)
})

function providerForEndedStep(db: DatabaseService, data: (typeof SessionEvent.Step.Ended.Type)["data"]) {
  return db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, data.sessionID),
        eq(EventTable.type, StepStartedType),
        sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${data.assistantMessageID}`,
      ),
    )
    .get()
    .pipe(
      Effect.map((row) => {
        const model = row?.data.model
        if (typeof model !== "object" || model === null || Array.isArray(model)) return undefined
        const ref = model as Record<string, unknown>
        return typeof ref.providerID === "string" ? ProviderV2.ID.make(ref.providerID) : undefined
      }),
      Effect.orDie,
    )
}

/**
 * Commits a staged revert and takes the deleted turns back out of the roll-up.
 *
 * V2 has no `PartRemoved`/`MessageRemoved` to hang the negative side off -- a
 * revert deletes `session_message` rows wholesale -- so without this the
 * columns would only ever climb and a reverted session would report spend it
 * no longer has any transcript for.
 *
 * The subtraction is sourced from the durable event log rather than from the
 * message rows, so it is exactly symmetric with the addition: only turns whose
 * `Step.Ended` this session actually projected are taken off. That symmetry is
 * what makes the two transcripts a session can hold without owning their events
 * -- a fork's copied rows, an adopted V1 transcript -- come out right. Neither
 * was ever added here, and neither gets subtracted.
 *
 * The message IDs are captured before the delete because that is the only
 * moment they exist; the subtraction runs after it, so a commit that rejects
 * the boundary leaves the columns untouched.
 */
const commitRevert = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly timestamp?: DateTime.Utc
  },
) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  // Only assistant messages ever settle a step, so this is the whole candidate set.
  const removed = boundary
    ? yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            eq(SessionMessageTable.type, "assistant"),
            gt(SessionMessageTable.seq, boundary.seq),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  yield* SessionRevert.projectCommit(db, input).pipe(Effect.orDie)
  if (removed.length === 0) return
  const ids = new Set<string>(removed.map((row) => row.id))
  // Keyed by message id rather than replayed off the event log, but symmetric
  // with the subtraction below all the same: a row only exists for a turn this
  // session projected, so a reverted turn stops counting as provider activity.
  yield* db
    .delete(ProviderUsageTable)
    .where(
      and(
        eq(ProviderUsageTable.session_id, input.sessionID),
        inArray(
          ProviderUsageTable.assistant_message_id,
          removed.map((row) => row.id),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  const rows = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, input.sessionID), eq(EventTable.type, StepEndedType)))
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) {
    const stored = storedStepUsage(row.data)
    if (!ids.has(stored.assistantMessageID)) continue
    yield* applyUsage(db, input.sessionID, stored.usage, -1)
  }
})

// `session.time.compacting` is the "this session is summarising itself right now" mark the
// session read path already surfaces (forge/src/session/session.ts maps the column onto
// `info.time.compacting`, and the SDK type ships it). V1 set it on entry and cleared it in a
// `defer`, so failure paths cleared it too.
//
// V2 has no compaction-failed event to hang a finalizer off, and `compaction.ts` has a live
// silent-failure exit after `Compaction.Started` has already been published (empty or failed
// summary returns false without publishing `Ended`). Pairing Started/Ended alone would leave
// such a session pinned as "compacting" forever, so the next model step clears it too — see
// the Step.Started projection. A crash between Started and Ended heals the same way.
function setCompacting(db: DatabaseService, sessionID: SessionSchema.ID, timestamp: DateTime.Utc) {
  return (
    db
      .update(SessionTable)
      // time_updated carries an $onUpdate default, so every UPDATE bumps it unless it is
      // written back to itself (same reason applyUsage does it). Compaction is agent
      // bookkeeping, not a session edit, and must not reorder the session list.
      .set({ time_compacting: DateTime.toEpochMillis(timestamp), time_updated: sql`${SessionTable.time_updated}` })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)
  )
}

function clearCompacting(db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    db
      .update(SessionTable)
      // Explicit null, not undefined: drizzle drops undefined columns from an UPDATE SET, so
      // `undefined` here would leave the old timestamp in place and silently do nothing.
      .set({ time_compacting: null, time_updated: sql`${SessionTable.time_updated}` })
      // Guarded so the per-step clear is a no-op index probe on the overwhelmingly common
      // path where nothing was compacting.
      .where(and(eq(SessionTable.id, sessionID), isNotNull(SessionTable.time_compacting)))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)
  )
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const sequence = event.durable.seq
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return Effect.gen(function* () {
    const messageID = SessionMessage.ID.make(id)
    const identity = yield* SessionInput.findIdentity(db, messageID)
    if (message.type === "user") {
      if (
        identity?.owner !== "input" ||
        identity.state !== "active" ||
        identity.admitted?.sessionID !== event.data.sessionID
      )
        return yield* Effect.die(new SessionInput.LifecycleConflict({ id: messageID }))
    } else {
      yield* SessionInput.projectMessageIdentity(db, {
        id: messageID,
        sessionID: event.data.sessionID,
        kind: message.type === "shell" ? "shell" : "message",
        creatorSeq: sequence,
        timeCreated: message.time.created,
      })
    }
    const input = yield* db
      .select({ sessionID: SessionInputTable.session_id })
      .from(SessionInputTable)
      .where(eq(SessionInputTable.id, messageID))
      .get()
      .pipe(Effect.orDie)
    if (
      (message.type === "user" && input?.sessionID !== event.data.sessionID) ||
      (message.type !== "user" && input !== undefined)
    )
      return yield* Effect.die(new SessionInput.LifecycleConflict({ id: messageID }))
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: messageID,
        session_id: event.data.sessionID,
        type,
        seq: sequence,
        time_created: DateTime.toEpochMillis(message.time.created),
        data,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const db = isWithReplicas(database.db) ? database.db.$primary : database.db
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        yield* db
          .delete(ToolExecutionTable)
          .where(eq(ToolExecutionTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    // One column, from the event's own timestamp. `Timestamps.time_updated` carries an `$onUpdate`
    // that would stamp wall-clock time on replay, and a rename is not a reason to rewrite the cost,
    // token, revert or compaction columns a concurrent turn owns -- which is exactly what routing
    // this through V1's whole-`SessionInfo` `session.updated` would have done.
    yield* events.project(SessionEvent.TitleUpdated, (event) =>
      db
        .update(SessionTable)
        .set({ title: event.data.title, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        if (event.data.revert)
          yield* commitRevert(db, {
            sessionID: event.data.sessionID,
            messageID: event.data.revert.messageID,
            timestamp: event.data.timestamp,
          })
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          source: event.data.source,
          agent: event.data.agent,
          model: event.data.model,
          command: event.data.command,
          kind: event.data.command ? "command" : "prompt",
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Harness.ProposalCreated, () => Effect.void)
    yield* events.project(SessionEvent.Harness.ProposalStatus, () => Effect.void)
    yield* events.project(SessionEvent.Harness.SnapshotCreated, () => Effect.void)
    yield* events.project(SessionEvent.Harness.Reloaded, () => Effect.void)
    yield* events.project(SessionEvent.Shell.Started, (event) =>
      run(db, event).pipe(Effect.andThen(SessionStatus.set(db, event.data.sessionID, { type: "busy" }))),
    )
    yield* events.project(SessionEvent.Shell.Ended, (event) =>
      run(db, event).pipe(Effect.andThen(SessionStatus.set(db, event.data.sessionID, { type: "idle" }))),
    )
    yield* events.project(SessionEvent.Step.Started, (event) =>
      run(db, event).pipe(
        Effect.andThen(clearCompacting(db, event.data.sessionID)),
        // Also clears any retry countdown: reaching a step start means the attempt the
        // countdown belonged to has been made.
        Effect.andThen(SessionStatus.set(db, event.data.sessionID, { type: "busy" })),
      ),
    )
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      run(db, event).pipe(
        // The session-level roll-up. `run` above writes the same turn's occupancy
        // onto the assistant message; this is the cumulative half, and the two
        // read different fields of the same event on purpose.
        Effect.andThen(applyUsage(db, event.data.sessionID, stepUsage(event.data))),
        Effect.andThen(recordProviderUsage(db, event.data)),
        Effect.andThen(SessionStatus.set(db, event.data.sessionID, { type: "idle" })),
      ),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) =>
      run(db, event).pipe(
        Effect.andThen(
          SessionStatus.set(db, event.data.sessionID, { type: "failed", message: event.data.error.message }),
        ),
      ),
    )
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // Deliberately not routed through `run`: a retry notice is not a transcript entry. V1 wrote a
    // `RetryPart` into the message, but V2's assistant content union is text/reasoning/tool and
    // widening it would reach into request translation. The waiting turn is durable *status*
    // instead -- which is what the client actually renders, and what a second viewer of a shared
    // session needs in order to tell "waiting on a rate limit" from "stalled".
    yield* events.project(SessionEvent.Retried, (event) =>
      SessionStatus.set(db, event.data.sessionID, {
        type: "retry",
        attempt: event.data.attempt,
        message: event.data.error.message,
        // Absolute deadline, reconstituted from the event's own timestamp so a replay of the
        // durable log yields the instant the wait was actually scheduled for.
        next: DateTime.toEpochMillis(event.data.timestamp) + event.data.delay,
        ...(event.data.action ? { action: event.data.action } : {}),
      }),
    )
    yield* events.project(SessionEvent.Compaction.Started, (event) =>
      setCompacting(db, event.data.sessionID, event.data.timestamp).pipe(
        Effect.andThen(SessionStatus.set(db, event.data.sessionID, { type: "busy" })),
      ),
    )
    yield* events.project(SessionEvent.Compaction.Ended, (event) =>
      run(db, event).pipe(
        Effect.andThen(clearCompacting(db, event.data.sessionID)),
        Effect.andThen(
          SessionStatus.set(db, event.data.sessionID, { type: event.data.reason === "auto" ? "busy" : "idle" }),
        ),
      ),
    )
    yield* events.project(SessionEvent.Compaction.Failed, (event) =>
      clearCompacting(db, event.data.sessionID).pipe(
        Effect.andThen(
          SessionStatus.set(db, event.data.sessionID, { type: event.data.mode === "auto" ? "busy" : "idle" }),
        ),
      ),
    )
    // Deliberately not paired with `setCompacting`/`clearCompacting`: prune is not a summarisation
    // and the session is not busy while it happens.
    yield* events.project(SessionEvent.Compaction.Pruned, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      commitRevert(db, {
        sessionID: event.data.sessionID,
        messageID: event.data.messageID,
        timestamp: event.data.timestamp,
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
