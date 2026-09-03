export * as SessionReplay from "./replay"

import { sql } from "drizzle-orm"
import { Effect, Encoding, Option, Result, Schema } from "effect"
import type { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { SessionDurable } from "@turenlabs/schema/durable-event-manifest"
import { Event } from "@turenlabs/schema/event"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { SessionV1 } from "@turenlabs/schema/session-v1"
import type { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionTable } from "./sql"
import { INTERNAL_METADATA_KEY } from "@turenlabs/schema/session"
import { fromRow } from "./info"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export const FILTER_FIELDS = [
  "session",
  "id",
  "message",
  "call",
  "type",
  "agent",
  "model",
  "tool",
  "status",
  "path",
  "after",
  "before",
  "has",
  "is",
] as const

export type FilterField = (typeof FILTER_FIELDS)[number]
export type Filter = { readonly field: FilterField; readonly value: string; readonly negated: boolean }
export type ParsedQuery = { readonly text: ReadonlyArray<string>; readonly filters: ReadonlyArray<Filter> }
export type EventMatch = {
  readonly id: Event.ID
  readonly aggregateID: string
  readonly seq: number
  readonly type: string
  readonly timestamp: number
  readonly messageID?: SessionMessage.ID
  readonly preview: string
}
export type Entry = {
  readonly kind: "session" | "event"
  readonly session: SessionSchema.Info
  readonly event?: EventMatch
  readonly score: number
}
export type Page = {
  readonly entries: ReadonlyArray<Entry>
  readonly total: number
  readonly nextCursor?: string
  readonly parsed: ParsedQuery
  readonly index: IndexState
}
export type IndexState = { readonly status: "indexing" | "ready"; readonly progress: number }
export type ReplayEvent = {
  readonly id: Event.ID
  readonly type: string
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly data: Record<string, unknown>
}
export type HistoryPage = {
  readonly events: ReadonlyArray<ReplayEvent>
  readonly previousCursor?: Event.ID
  readonly nextCursor?: Event.ID
}

export class QueryError extends Schema.TaggedErrorClass<QueryError>()("SessionReplay.QueryError", {
  message: Schema.String,
  position: Schema.Int,
}) {}

// Rebuilds always move to a new table suffix. Never drop a prior large index on a request path.
const TABLE = "session_replay_v3"
const FTS = "session_replay_fts_v3"
const PENDING = "session_replay_pending_v3"
const table = sql.identifier(TABLE)
const fts = sql.identifier(FTS)
const pending = sql.identifier(PENDING)
const MAX_QUERY_LENGTH = 2_048
const MAX_TOKENS = 64
const MAX_TERMS = 128
const SESSION_INDEXED_CHARS = 2_048
const EVENT_INDEXED_FRAGMENT_CHARS = 960
const INDEXED_PATH_CHARS = 1_024
const SESSION_BACKFILL_BATCH = 64
const EVENT_BACKFILL_BATCH = 16
const LEGACY_RECLAIM_BATCH = SESSION_BACKFILL_BATCH + EVENT_BACKFILL_BATCH
const BACKFILL_PAUSE_MS = 100
const INDEX_VERSION = 3
const replayDefinitions = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
const eventTypes = [...replayDefinitions.keys()]
const EventData = Schema.Record(Schema.String, Schema.Unknown)
const decodeEventData = Schema.decodeUnknownOption(EventData)
const decodeStoredEventData = Schema.decodeUnknownOption(Schema.fromJsonString(EventData))
const SearchCursor = Schema.Struct({ timestamp: Schema.Finite, entryID: Schema.String })
const SearchCursorJson = Schema.fromJsonString(SearchCursor)
const decodeSearchCursor = Schema.decodeUnknownOption(SearchCursorJson)
const encodeSearchCursor = Schema.encodeSync(SearchCursorJson)

const createTable = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id integer PRIMARY KEY,
  entry_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('session', 'event')),
  session_id text NOT NULL,
  commit_order integer NOT NULL,
  aggregate_id text,
  event_id text,
  seq integer,
  timestamp integer NOT NULL,
  event_type text,
  message_id text,
  call_id text,
  agent text,
  model_provider text,
  model_id text,
  tool text,
  status text,
  paths text NOT NULL DEFAULT '',
  has_error integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE
)`

const createFts = `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(
  content,
  paths,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
)`
const createMeta = `CREATE TABLE IF NOT EXISTS session_replay_meta (
  key text PRIMARY KEY,
  value integer NOT NULL
)`
const createPending = `CREATE TABLE IF NOT EXISTS ${PENDING} (
  kind text NOT NULL CHECK (kind IN ('session', 'event')),
  row_id integer NOT NULL,
  PRIMARY KEY (kind, row_id)
)`

const indexes = [
  `CREATE INDEX IF NOT EXISTS session_replay_session_seq_idx_v3 ON ${TABLE} (session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS session_replay_session_commit_idx_v3 ON ${TABLE} (session_id, kind, commit_order)`,
  `CREATE INDEX IF NOT EXISTS session_replay_aggregate_seq_idx_v3 ON ${TABLE} (aggregate_id, seq)`,
  `CREATE INDEX IF NOT EXISTS session_replay_aggregate_type_seq_idx_v3 ON ${TABLE} (aggregate_id, event_type, seq)`,
  `CREATE INDEX IF NOT EXISTS session_replay_call_context_idx_v3 ON ${TABLE} (aggregate_id, call_id, message_id, seq)`,
  `CREATE INDEX IF NOT EXISTS session_replay_kind_timestamp_idx_v3 ON ${TABLE} (kind, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS session_replay_timestamp_idx_v3 ON ${TABLE} (timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS session_replay_event_type_idx_v3 ON ${TABLE} (event_type)`,
  `CREATE INDEX IF NOT EXISTS session_replay_message_idx_v3 ON ${TABLE} (message_id)`,
  `CREATE INDEX IF NOT EXISTS session_replay_call_idx_v3 ON ${TABLE} (call_id)`,
  `CREATE INDEX IF NOT EXISTS session_replay_agent_idx_v3 ON ${TABLE} (agent)`,
  `CREATE INDEX IF NOT EXISTS session_replay_model_provider_idx_v3 ON ${TABLE} (model_provider)`,
  `CREATE INDEX IF NOT EXISTS session_replay_model_id_idx_v3 ON ${TABLE} (model_id)`,
  `CREATE INDEX IF NOT EXISTS session_replay_tool_idx_v3 ON ${TABLE} (tool)`,
  `CREATE INDEX IF NOT EXISTS session_replay_status_idx_v3 ON ${TABLE} (status)`,
  `CREATE INDEX IF NOT EXISTS session_replay_error_idx_v3 ON ${TABLE} (has_error)`,
] as const

const sessionContent = (row: "NEW" | "s") =>
  `substr(coalesce(${row}.title, '') || ' ' || coalesce(${row}.directory, '') || ' ' || coalesce(${row}.path, '') || ' ' || coalesce(${row}.agent, '') || ' ' || coalesce(${row}.model, '') || ' ' || coalesce(${row}.metadata, ''), 1, ${SESSION_INDEXED_CHARS})`

const eventSession = (row: "NEW" | "e") => `coalesce(json_extract(${row}.data, '$.sessionID'), ${row}.aggregate_id)`

const eventTimestamp = (row: "NEW" | "e") => `coalesce(
  cast(json_extract(${row}.data, '$.timestamp') AS integer),
  cast(json_extract(${row}.data, '$.time') AS integer),
  cast(json_extract(${row}.data, '$.info.time.updated') AS integer),
  cast(json_extract(${row}.data, '$.info.time.created') AS integer),
  cast(json_extract(${row}.data, '$.part.time.created') AS integer),
  0
)`

const eventTool = (row: "NEW" | "e") => `lower(coalesce(
  json_extract(${row}.data, '$.tool'),
  json_extract(${row}.data, '$.name'),
  json_extract(${row}.data, '$.part.tool')
))`

const eventTurnField = (row: "NEW" | "e", path: "$.agent" | "$.model.providerID" | "$.model.id") =>
  `lower(coalesce(
    json_extract(${row}.data, '${path}'),
    json_extract(${row}.data, '$.info${path.slice(1)}'),
    json_extract(${row}.data, '$.task${path.slice(1)}')
  ))`

const eventStatus = (row: "NEW" | "e") => `lower(coalesce(
  json_extract(${row}.data, '$.status'),
  json_extract(${row}.data, '$.task.status'),
  json_extract(${row}.data, '$.operation.status'),
  json_extract(${row}.data, '$.part.state.status'),
  CASE
    WHEN ${row}.type LIKE '%.failed.%' THEN 'failed'
    WHEN ${row}.type LIKE '%.success.%' THEN 'success'
    WHEN ${row}.type LIKE '%.started.%' THEN 'started'
    WHEN ${row}.type LIKE '%.ended.%' THEN 'ended'
  END
))`

const eventContent = (row: "NEW" | "e") =>
  `${row}.type || ' ' || substr(${row}.data, 1, ${EVENT_INDEXED_FRAGMENT_CHARS}) || ' ' || substr(${row}.data, -${EVENT_INDEXED_FRAGMENT_CHARS})`

const eventPaths = (row: "NEW" | "e") => `substr(coalesce(
  json_extract(${row}.data, '$.outputPaths'),
  json_extract(${row}.data, '$.files'),
  json_extract(${row}.data, '$.task.authority.writeRoots'),
  json_extract(${row}.data, '$.info.directory'),
  json_extract(${row}.data, '$.info.path'),
  ''
), 1, ${INDEXED_PATH_CHARS})`

const eventValues = (row: "NEW" | "e") => `
  ${row}.id,
  'event',
  ${eventSession(row)},
  ${row}.rowid,
  ${row}.aggregate_id,
  ${row}.id,
  ${row}.seq,
  ${eventTimestamp(row)},
  ${row}.type,
  coalesce(json_extract(${row}.data, '$.messageID'), json_extract(${row}.data, '$.assistantMessageID'), CASE WHEN ${row}.type LIKE 'message.updated.%' THEN json_extract(${row}.data, '$.info.id') END, json_extract(${row}.data, '$.part.messageID'), json_extract(${row}.data, '$.task.actor.assistantMessageID'), json_extract(${row}.data, '$.operation.actor.assistantMessageID')),
  coalesce(json_extract(${row}.data, '$.callID'), json_extract(${row}.data, '$.part.callID'), json_extract(${row}.data, '$.task.actor.toolCallID'), json_extract(${row}.data, '$.operation.actor.toolCallID')),
  ${eventTurnField(row, "$.agent")},
  ${eventTurnField(row, "$.model.providerID")},
  ${eventTurnField(row, "$.model.id")},
  ${eventTool(row)},
  ${eventStatus(row)},
  ${eventPaths(row)},
  CASE WHEN json_type(${row}.data, '$.error') IS NOT NULL OR json_type(${row}.data, '$.task.error') IS NOT NULL OR json_type(${row}.data, '$.operation.error') IS NOT NULL OR json_type(${row}.data, '$.part.state.error') IS NOT NULL OR ${row}.type LIKE '%.failed.%' THEN 1 ELSE 0 END,
  ${eventContent(row)}`

const triggers = [
  `CREATE TRIGGER IF NOT EXISTS session_replay_fts_insert_v3 AFTER INSERT ON ${TABLE} BEGIN
    INSERT INTO ${FTS} (rowid, content, paths) VALUES (NEW.rowid, NEW.content, NEW.paths);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_fts_update_v3 AFTER UPDATE OF content, paths ON ${TABLE} BEGIN
    DELETE FROM ${FTS} WHERE rowid = OLD.rowid;
    INSERT INTO ${FTS} (rowid, content, paths) VALUES (NEW.rowid, NEW.content, NEW.paths);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_fts_delete_v3 AFTER DELETE ON ${TABLE} BEGIN
    DELETE FROM ${FTS} WHERE rowid = OLD.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_tool_propagate_v3 AFTER INSERT ON ${TABLE}
   WHEN NEW.kind = 'event' AND NEW.call_id IS NOT NULL BEGIN
    UPDATE ${TABLE}
    SET tool = (SELECT known.tool
      FROM ${TABLE} AS known
      WHERE known.aggregate_id = NEW.aggregate_id
        AND known.call_id = NEW.call_id
        AND known.message_id IS NEW.message_id
        AND known.tool IS NOT NULL
      ORDER BY known.seq
      LIMIT 1)
    WHERE aggregate_id = NEW.aggregate_id
      AND call_id = NEW.call_id
      AND message_id IS NEW.message_id
      AND tool IS NULL
      AND EXISTS (SELECT 1
        FROM ${TABLE} AS known
        WHERE known.aggregate_id = NEW.aggregate_id
          AND known.call_id = NEW.call_id
          AND known.message_id IS NEW.message_id
          AND known.tool IS NOT NULL);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_turn_propagate_v3 AFTER INSERT ON ${TABLE}
   WHEN NEW.kind = 'event' BEGIN
    UPDATE ${TABLE}
    SET agent = coalesce(agent, (SELECT turn.agent FROM ${TABLE} AS turn
          WHERE turn.aggregate_id = NEW.aggregate_id
            AND turn.event_type LIKE 'session.next.step.started.%'
            AND turn.seq <= NEW.seq
          ORDER BY turn.seq DESC LIMIT 1)),
        model_provider = coalesce(model_provider, (SELECT turn.model_provider FROM ${TABLE} AS turn
          WHERE turn.aggregate_id = NEW.aggregate_id
            AND turn.event_type LIKE 'session.next.step.started.%'
            AND turn.seq <= NEW.seq
          ORDER BY turn.seq DESC LIMIT 1)),
        model_id = coalesce(model_id, (SELECT turn.model_id FROM ${TABLE} AS turn
          WHERE turn.aggregate_id = NEW.aggregate_id
            AND turn.event_type LIKE 'session.next.step.started.%'
            AND turn.seq <= NEW.seq
          ORDER BY turn.seq DESC LIMIT 1))
    WHERE id = NEW.id;
    UPDATE ${TABLE}
    SET agent = coalesce(agent, NEW.agent),
        model_provider = coalesce(model_provider, NEW.model_provider),
        model_id = coalesce(model_id, NEW.model_id)
    WHERE aggregate_id = NEW.aggregate_id
      AND seq >= NEW.seq
      AND NEW.event_type LIKE 'session.next.step.started.%'
      AND (agent IS NULL OR model_provider IS NULL OR model_id IS NULL);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_session_insert_v3 AFTER INSERT ON session
   WHEN coalesce((SELECT value FROM session_replay_meta WHERE key = 'enabled'), 0) = 1 BEGIN
    INSERT OR IGNORE INTO ${PENDING} (kind, row_id) VALUES ('session', NEW.rowid);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_session_update_v3 AFTER UPDATE ON session
   WHEN coalesce((SELECT value FROM session_replay_meta WHERE key = 'enabled'), 0) = 1 BEGIN
    INSERT OR IGNORE INTO ${PENDING} (kind, row_id) VALUES ('session', NEW.rowid);
  END`,
  `CREATE TRIGGER IF NOT EXISTS session_replay_event_insert_v3 AFTER INSERT ON event
   WHEN coalesce((SELECT value FROM session_replay_meta WHERE key = 'enabled'), 0) = 1 BEGIN
    INSERT OR IGNORE INTO ${PENDING} (kind, row_id) VALUES ('event', NEW.rowid);
  END`,
] as const

/**
 * Creates empty versioned replay structures on first use without scanning historical rows.
 * This lives outside schema.gen because fresh databases stamp TypeScript migrations as complete.
 */
export function ensure(db: Database) {
  return Effect.gen(function* () {
    const table = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_replay_meta'`,
    )
    if (table) {
      const version = yield* db.get<{ value: number }>(sql`SELECT value FROM session_replay_meta WHERE key = 'version'`)
      if (version?.value === INDEX_VERSION) return
    }
    return yield* db.transaction((tx) => ensureLocked(tx), { behavior: "immediate" })
  })
}

function ensureLocked(db: Database | Transaction) {
  return Effect.gen(function* () {
    yield* db.run(sql.raw(createMeta))
    const version = yield* db.get<{ value: number }>(sql`SELECT value FROM session_replay_meta WHERE key = 'version'`)
    if (version?.value === INDEX_VERSION) return
    yield* Effect.forEach(
      [
        // Disable the original synchronous indexer without touching its potentially large tables.
        "session_replay_fts_insert",
        "session_replay_fts_update",
        "session_replay_fts_delete",
        "session_replay_tool_propagate",
        "session_replay_turn_propagate",
        "session_replay_session_insert",
        "session_replay_session_update",
        "session_replay_event_insert",
        "session_replay_fts_insert_v3",
        "session_replay_fts_update_v3",
        "session_replay_fts_delete_v3",
        "session_replay_tool_propagate_v3",
        "session_replay_turn_propagate_v3",
        "session_replay_session_insert_v3",
        "session_replay_session_update_v3",
        "session_replay_event_insert_v3",
      ],
      (name) => db.run(sql.raw(`DROP TRIGGER IF EXISTS ${name}`)),
      { discard: true },
    )
    yield* db.run(sql.raw(createTable))
    yield* Effect.forEach(indexes, (statement) => db.run(sql.raw(statement)), { discard: true })
    yield* db.run(sql.raw(createFts))
    yield* db.run(sql.raw(createPending))

    yield* Effect.forEach(triggers, (statement) => db.run(sql.raw(statement)), { discard: true })
    yield* db.run(sql`DELETE FROM session_replay_meta WHERE key <> 'version'`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value)
      SELECT 'event_before', coalesce(max(rowid) + 1, 1) FROM event`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value)
      SELECT 'event_max', coalesce(max(rowid), 0) FROM event`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value)
      SELECT 'session_before', coalesce(max(rowid) + 1, 1) FROM session`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value)
      SELECT 'session_max', coalesce(max(rowid), 0) FROM session`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value) VALUES ('version', ${INDEX_VERSION})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    yield* db.run(sql`INSERT INTO session_replay_meta (key, value) VALUES ('enabled', 0)`)
  })
}

export function enabled(db: Database) {
  return db
    .get<{ value: number }>(sql`SELECT value FROM session_replay_meta WHERE key = 'enabled'`)
    .pipe(Effect.map((row) => row?.value === 1))
}

export function enable(db: Database) {
  return db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const active = yield* tx.get<{ value: number }>(
          sql`SELECT value FROM session_replay_meta WHERE key = 'enabled'`,
        )
        if (active?.value === 1) return
        yield* tx.run(sql`UPDATE session_replay_meta
          SET value = (SELECT coalesce(max(rowid) + 1, 1) FROM session)
          WHERE key = 'session_before'`)
        yield* tx.run(sql`UPDATE session_replay_meta
          SET value = (SELECT coalesce(max(rowid), 0) FROM session)
          WHERE key = 'session_max'`)
        yield* tx.run(sql`UPDATE session_replay_meta
          SET value = (SELECT coalesce(max(rowid) + 1, 1) FROM event)
          WHERE key = 'event_before'`)
        yield* tx.run(sql`UPDATE session_replay_meta
          SET value = (SELECT coalesce(max(rowid), 0) FROM event)
          WHERE key = 'event_max'`)
        yield* tx.run(sql`INSERT INTO session_replay_meta (key, value) VALUES ('enabled', 1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      }),
    { behavior: "immediate" },
  )
}

export function backfill(db: Database) {
  return ensure(db).pipe(Effect.andThen(backfillLoop(db)))
}

export function backfillBatch(db: Database, options: { readonly sessions?: number; readonly events?: number } = {}) {
  return hasBackfillWork(db).pipe(
    Effect.flatMap((work) =>
      work
        ? db.transaction((tx) => backfillBatchLocked(tx, options), { behavior: "immediate" })
        : Effect.succeed({ complete: true, processed: 0 }),
    ),
  )
}

function hasBackfillWork(db: Database) {
  return db
    .get<{ work: number }>(
      sql.raw(`SELECT (
      EXISTS(SELECT 1 FROM ${PENDING})
      OR EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_replay')
      OR coalesce((SELECT value > 1 FROM session_replay_meta WHERE key = 'session_before'), 0)
      OR coalesce((SELECT value > 1 FROM session_replay_meta WHERE key = 'event_before'), 0)
    ) AS work`),
    )
    .pipe(Effect.map((row) => row?.work === 1))
}

function backfillLoop(db: Database): Effect.Effect<void> {
  return backfillBatch(db).pipe(
    Effect.catch(() => Effect.sleep(1_000).pipe(Effect.as({ complete: false }))),
    Effect.flatMap((result) =>
      Effect.sleep(result.complete ? 1_000 : BACKFILL_PAUSE_MS).pipe(Effect.andThen(backfillLoop(db))),
    ),
  )
}

function backfillBatchLocked(
  db: Database | Transaction,
  options: { readonly sessions?: number; readonly events?: number },
) {
  return Effect.gen(function* () {
    const pending = yield* backfillPending(db)
    if (pending > 0) return { complete: false, processed: pending }
    const legacy = yield* reclaimLegacyBatch(db)
    const cursors = yield* db.all<{ key: string; value: number }>(
      sql`SELECT key, value FROM session_replay_meta WHERE key IN ('session_before', 'event_before')`,
    )
    const values = new Map(cursors.map((item) => [item.key, item.value]))
    const sessions = yield* backfillSessions(db, values.get("session_before") ?? 0, options.sessions)
    const events = yield* backfillEvents(db, values.get("event_before") ?? 0, options.events)
    return {
      complete: !legacy.remaining && sessions.before <= 1 && events.before <= 1,
      processed: legacy.processed + sessions.processed + events.processed,
    }
  })
}

function reclaimLegacyBatch(db: Database | Transaction) {
  return Effect.gen(function* () {
    const legacy = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_replay'`,
    )
    if (!legacy) return { remaining: false, processed: 0 }
    const replayRows = yield* db.all<{ rowid: number }>(
      sql.raw(`SELECT rowid FROM session_replay LIMIT ${LEGACY_RECLAIM_BATCH}`),
    )
    if (replayRows.length > 0) {
      const ids = replayRows.map((item) => item.rowid).join(",")
      const legacyFts = yield* db.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_replay_fts'`,
      )
      if (legacyFts) yield* db.run(sql.raw(`DELETE FROM session_replay_fts WHERE rowid IN (${ids})`))
      yield* db.run(sql.raw(`DELETE FROM session_replay WHERE rowid IN (${ids})`))
      return { remaining: true, processed: replayRows.length }
    }

    const legacyFts = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_replay_fts'`,
    )
    if (legacyFts) {
      const ftsRows = yield* db.all<{ rowid: number }>(
        sql.raw(`SELECT rowid FROM session_replay_fts LIMIT ${LEGACY_RECLAIM_BATCH}`),
      )
      if (ftsRows.length > 0) {
        yield* db.run(
          sql.raw(`DELETE FROM session_replay_fts WHERE rowid IN (${ftsRows.map((item) => item.rowid).join(",")})`),
        )
        return { remaining: true, processed: ftsRows.length }
      }
      yield* db.run(sql.raw("DROP TABLE session_replay_fts"))
    }
    yield* db.run(sql.raw("DROP TABLE session_replay"))
    return { remaining: false, processed: 0 }
  })
}

function backfillPending(db: Database | Transaction) {
  return Effect.gen(function* () {
    const sessions = yield* db.all<{ row_id: number }>(
      sql`SELECT row_id FROM ${pending} WHERE kind = 'session' ORDER BY row_id DESC LIMIT 50`,
    )
    const events = yield* db.all<{ row_id: number }>(
      sql`SELECT row_id FROM ${pending} WHERE kind = 'event' ORDER BY row_id DESC LIMIT ${EVENT_BACKFILL_BATCH}`,
    )
    if (sessions.length > 0) {
      const ids = sessions.map((item) => item.row_id).join(",")
      yield* db.run(
        sql.raw(`INSERT INTO ${TABLE} (
          entry_id, kind, session_id, commit_order, timestamp, agent, model_provider, model_id, paths, content
        )
        SELECT 'session:' || s.id, 'session', s.id, s.rowid, s.time_updated,
          lower(s.agent), lower(json_extract(s.model, '$.providerID')), lower(json_extract(s.model, '$.id')),
          substr(coalesce(s.directory, '') || ' ' || coalesce(s.path, ''), 1, ${INDEXED_PATH_CHARS}),
          ${sessionContent("s")}
        FROM session AS s
        WHERE s.rowid IN (${ids})
        ON CONFLICT(entry_id) DO UPDATE SET
          timestamp = excluded.timestamp,
          agent = excluded.agent,
          model_provider = excluded.model_provider,
          model_id = excluded.model_id,
          paths = excluded.paths,
          content = excluded.content`),
      )
      yield* db.run(sql.raw(`DELETE FROM ${PENDING} WHERE kind = 'session' AND row_id IN (${ids})`))
    }
    if (events.length > 0) {
      const ids = events.map((item) => item.row_id).join(",")
      yield* db.run(
        sql.raw(`INSERT OR IGNORE INTO ${TABLE} (
          entry_id, kind, session_id, commit_order, aggregate_id, event_id, seq, timestamp, event_type, message_id, call_id,
          agent, model_provider, model_id, tool, status, paths, has_error, content
        )
        SELECT ${eventValues("e")}
        FROM event AS e
        INNER JOIN session AS s ON s.id = ${eventSession("e")}
        WHERE e.rowid IN (${ids})`),
      )
      yield* db.run(sql.raw(`DELETE FROM ${PENDING} WHERE kind = 'event' AND row_id IN (${ids})`))
    }
    return sessions.length + events.length
  })
}

function backfillSessions(db: Database | Transaction, cursor: number, limit = SESSION_BACKFILL_BATCH) {
  if (cursor <= 1) return Effect.succeed({ before: cursor, processed: 0 })
  const batch = Math.max(1, Math.min(1_000, Math.floor(limit)))
  return Effect.gen(function* () {
    const rows = yield* db.all<{ rowid: number }>(
      sql`SELECT rowid FROM session WHERE rowid < ${cursor} ORDER BY rowid DESC LIMIT ${batch}`,
    )
    const before = rows.at(-1)?.rowid ?? 0
    if (rows.length > 0)
      yield* db.run(
        sql.raw(`INSERT OR IGNORE INTO ${TABLE} (
          entry_id, kind, session_id, commit_order, timestamp, agent, model_provider, model_id, paths, content
        )
        SELECT 'session:' || s.id, 'session', s.id, s.rowid, s.time_updated,
          lower(s.agent), lower(json_extract(s.model, '$.providerID')), lower(json_extract(s.model, '$.id')),
          substr(coalesce(s.directory, '') || ' ' || coalesce(s.path, ''), 1, ${INDEXED_PATH_CHARS}),
          ${sessionContent("s")}
        FROM session AS s
        WHERE s.rowid >= ${before} AND s.rowid < ${cursor}
        ORDER BY s.rowid DESC`),
      )
    yield* db.run(sql`UPDATE session_replay_meta SET value = ${before} WHERE key = 'session_before'`)
    return { before, processed: rows.length }
  })
}

function backfillEvents(db: Database | Transaction, cursor: number, limit = EVENT_BACKFILL_BATCH) {
  if (cursor <= 1) return Effect.succeed({ before: cursor, processed: 0 })
  const batch = Math.max(1, Math.min(1_000, Math.floor(limit)))
  return Effect.gen(function* () {
    const rows = yield* db.all<{ rowid: number }>(
      sql`SELECT rowid FROM event WHERE rowid < ${cursor} ORDER BY rowid DESC LIMIT ${batch}`,
    )
    const before = rows.at(-1)?.rowid ?? 0
    if (rows.length > 0)
      yield* db.run(
        sql.raw(`INSERT OR IGNORE INTO ${TABLE} (
          entry_id, kind, session_id, commit_order, aggregate_id, event_id, seq, timestamp, event_type, message_id, call_id,
          agent, model_provider, model_id, tool, status, paths, has_error, content
        )
        SELECT ${eventValues("e")}
        FROM event AS e
        INNER JOIN session AS s ON s.id = ${eventSession("e")}
        WHERE e.rowid >= ${before} AND e.rowid < ${cursor}
        ORDER BY e.rowid DESC`),
      )
    yield* db.run(sql`UPDATE session_replay_meta SET value = ${before} WHERE key = 'event_before'`)
    return { before, processed: rows.length }
  })
}

export function status(db: Database) {
  return statusLocked(db)
}

function statusLocked(db: Database | Transaction) {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ key: string; value: number }>(
      sql`SELECT key, value FROM session_replay_meta
          WHERE key IN ('session_before', 'session_max', 'event_before', 'event_max')`,
    )
    const values = new Map(rows.map((item) => [item.key, item.value]))
    const sessionBefore = values.get("session_before") ?? 0
    const eventBefore = values.get("event_before") ?? 0
    const pending = yield* db.get<{ pending: number }>(sql.raw(`SELECT EXISTS(SELECT 1 FROM ${PENDING}) AS pending`))
    const legacy = yield* db.get<{ legacy: number }>(
      sql`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_replay') AS legacy`,
    )
    const total = (values.get("session_max") ?? 0) + (values.get("event_max") ?? 0)
    const remaining = Math.max(0, sessionBefore - 1) + Math.max(0, eventBefore - 1)
    const historyReady = sessionBefore <= 1 && eventBefore <= 1
    return {
      status: historyReady && !pending?.pending && !legacy?.legacy ? ("ready" as const) : ("indexing" as const),
      progress: historyReady
        ? pending?.pending || legacy?.legacy
          ? 0.99
          : 1
        : total === 0
          ? 1
          : Math.max(0, Math.min(1, (total - remaining) / total)),
    } satisfies IndexState
  })
}

export function parse(input: string, now = Date.now()): ParsedQuery {
  if (input.length > MAX_QUERY_LENGTH)
    throw new QueryError({ message: `Replay query exceeds ${MAX_QUERY_LENGTH} characters`, position: MAX_QUERY_LENGTH })

  const text: string[] = []
  const filters: Filter[] = []
  const tokens = lex(input)
  if (tokens.length > MAX_TOKENS)
    throw new QueryError({
      message: `Replay query exceeds ${MAX_TOKENS} tokens`,
      position: tokens[MAX_TOKENS]!.position,
    })

  tokens.forEach((token) => {
    const negated = token.value.startsWith("-")
    const value = negated ? token.value.slice(1) : token.value
    const separator = value.indexOf(":")
    if (separator < 1) {
      if (negated)
        throw new QueryError({ message: "Negation is supported only for field filters", position: token.position })
      text.push(value)
      return
    }

    const field = value.slice(0, separator).toLowerCase()
    if (!FILTER_FIELDS.includes(field as FilterField))
      throw new QueryError({ message: `Unknown replay filter: ${field}`, position: token.position })
    const filterValue = value.slice(separator + 1)
    if (!filterValue)
      throw new QueryError({
        message: `Replay filter ${field} requires a value`,
        position: token.position + separator + 1,
      })
    if ((field === "after" || field === "before") && negated)
      throw new QueryError({ message: `${field} cannot be negated`, position: token.position })
    if (field === "after" || field === "before") parseInstant(filterValue, now, token.position + separator + 1)
    if (field === "has" && filterValue.toLowerCase() !== "error")
      throw new QueryError({ message: "The has filter currently supports only has:error", position: token.position })
    if (field === "is" && filterValue.toLowerCase() !== "session" && filterValue.toLowerCase() !== "event")
      throw new QueryError({ message: "The is filter must be is:session or is:event", position: token.position })
    filters.push({ field: field as FilterField, value: filterValue, negated })
  })

  return { text, filters }
}

export function search(
  db: Database,
  input: { readonly query: string; readonly limit: number; readonly cursor?: string },
) {
  return db
    .transaction((tx) => searchLocked(tx, input), { behavior: "deferred" })
    .pipe(Effect.catch((error) => (error instanceof QueryError ? Effect.fail(error) : Effect.die(error))))
}

function searchLocked(
  db: Database | Transaction,
  input: { readonly query: string; readonly limit: number; readonly cursor?: string },
) {
  return Effect.gen(function* () {
    const now = Date.now()
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Math.floor(input.limit))) : 50
    const parsed = yield* Effect.try({
      try: () => parse(input.query, now),
      catch: (error) =>
        error instanceof QueryError ? error : new QueryError({ message: "Invalid replay query", position: 0 }),
    })
    const terms = parsed.text.flatMap(tokenize).slice(0, MAX_TERMS)
    const conditions = [
      sql`r.session_id IN (SELECT id FROM session WHERE id NOT LIKE 'ses_lobby_%' AND coalesce(json_extract(metadata, ${`$."${INTERNAL_METADATA_KEY}"`}), 0) != 1)`,
    ]
    const matchParts: string[] = []
    if (parsed.text.length > 0 && terms.length === 0) conditions.push(sql`0`)
    if (terms.length > 0) matchParts.push(terms.map((term) => `"${term}"`).join(" AND "))

    parsed.filters.forEach((filter) => {
      const value = filter.value.toLowerCase()
      const condition = (() => {
        if (filter.field === "session") return sql`r.session_id = ${filter.value}`
        if (filter.field === "id") return sql`(r.entry_id = ${filter.value} OR r.event_id = ${filter.value})`
        if (filter.field === "message") return sql`r.message_id = ${filter.value}`
        if (filter.field === "call") return sql`r.call_id = ${filter.value}`
        if (filter.field === "agent") return sql`r.agent = ${value}`
        if (filter.field === "tool") return sql`r.tool = ${value}`
        if (filter.field === "status") return sql`r.status = ${value}`
        if (filter.field === "model") return sql`(r.model_id = ${value} OR r.model_provider = ${value})`
        if (filter.field === "after") return sql`r.timestamp >= ${parseInstant(filter.value, now, 0)}`
        if (filter.field === "before") return sql`r.timestamp < ${parseInstant(filter.value, now, 0)}`
        if (filter.field === "has") return sql`r.has_error = 1`
        if (filter.field === "is") return sql`r.kind = ${value}`
        if (filter.field === "type") {
          const types = matchingEventTypes(value)
          if (types.length === 0) return sql`0`
          return sql`(${sql.join(
            types.map((type) => sql`r.event_type LIKE ${`${type}.%`}`),
            sql` OR `,
          )})`
        }
        return undefined
      })()
      if (condition) conditions.push(filter.negated ? sql`NOT (${condition})` : condition)
      if (filter.field !== "path") return
      const pathTerms = tokenize(filter.value)
      if (pathTerms.length === 0) {
        conditions.push(filter.negated ? sql`1` : sql`0`)
        return
      }
      const expression = `paths : (${pathTerms.map((term) => `"${term}"`).join(" AND ")})`
      if (!filter.negated) {
        matchParts.push(expression)
        return
      }
      conditions.push(sql`r.rowid NOT IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ${expression})`)
    })

    const match = matchParts.length > 0 ? matchParts.map((part) => `(${part})`).join(" AND ") : undefined
    const source = match ? sql`FROM ${fts} INNER JOIN ${table} AS r ON r.rowid = ${fts}.rowid` : sql`FROM ${table} AS r`
    if (match) conditions.push(sql`${fts} MATCH ${match}`)
    const totalWhere = sql`WHERE ${sql.join(conditions, sql` AND `)}`
    const totalRow = yield* db
      .get<{ total: number }>(sql`SELECT count(*) AS total ${source} ${totalWhere}`)
      .pipe(Effect.orDie)
    if (input.cursor) {
      const decoded = Encoding.decodeBase64UrlString(input.cursor)
      if (Result.isFailure(decoded))
        return yield* new QueryError({ message: "Invalid replay search cursor", position: 0 })
      const anchor = decodeSearchCursor(decoded.success)
      if (Option.isNone(anchor)) return yield* new QueryError({ message: "Invalid replay search cursor", position: 0 })
      conditions.push(
        sql`(r.timestamp < ${anchor.value.timestamp} OR (r.timestamp = ${anchor.value.timestamp} AND r.entry_id < ${anchor.value.entryID}))`,
      )
    }
    const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`
    const score = match ? sql`-bm25(${fts})` : sql`0`
    const preview = match ? sql`snippet(${fts}, 0, '', '', '...', 32)` : sql`substr(r.content, 1, 320)`
    const rows = yield* db
      .all<SearchRow>(
        sql`SELECT
        r.entry_id,
        r.kind,
        r.session_id,
        r.aggregate_id,
        r.event_id,
        r.seq,
        r.timestamp,
        r.event_type,
        r.message_id,
        ${preview} AS preview,
        ${score} AS score
      ${source}
      ${where}
      ORDER BY r.timestamp DESC, r.entry_id DESC
      LIMIT ${limit + 1}`,
      )
      .pipe(Effect.orDie)
    const page = rows.slice(0, limit)
    const sessionIDs = [...new Set(page.map((row) => row.session_id))]
    const sessions =
      sessionIDs.length === 0
        ? []
        : yield* db
            .select()
            .from(SessionTable)
            .where(
              sql`${SessionTable.id} IN (${sql.join(
                sessionIDs.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .all()
            .pipe(Effect.orDie)
    const byID = new Map<string, SessionSchema.Info>(sessions.map((session) => [session.id, fromRow(session)]))
    const entries = page.flatMap((row): Entry[] => {
      const session = byID.get(row.session_id)
      if (!session) return []
      if (row.kind === "session") return [{ kind: "session", session, score: row.score }]
      const durable = row.event_type ? storedType(row.event_type) : undefined
      if (!durable || !row.event_id || row.seq === null || !row.aggregate_id) return []
      return [
        {
          kind: "event",
          session,
          score: row.score,
          event: {
            id: Event.ID.make(row.event_id),
            aggregateID: row.aggregate_id,
            seq: row.seq,
            type: durable.type,
            timestamp: row.timestamp,
            ...(row.message_id?.startsWith("msg_") ? { messageID: SessionMessage.ID.make(row.message_id) } : {}),
            preview: row.preview,
          },
        },
      ]
    })
    const total = totalRow?.total ?? 0
    const index = yield* statusLocked(db)
    return {
      entries,
      total,
      ...(rows.length > limit && page.at(-1)
        ? {
            nextCursor: Encoding.encodeBase64Url(
              encodeSearchCursor({ timestamp: page.at(-1)!.timestamp, entryID: page.at(-1)!.entry_id }),
            ),
          }
        : {}),
      parsed,
      index,
    } satisfies Page
  })
}

type SearchRow = {
  entry_id: string
  kind: "session" | "event"
  session_id: string
  event_id: string | null
  aggregate_id: string | null
  seq: number | null
  timestamp: number
  event_type: string | null
  message_id: string | null
  preview: string
  score: number
}

function matchingEventTypes(value: string) {
  const normalized = value.replace(/^session\.next\./, "").replace(/\.\d+$/, "")
  return [
    ...new Set(
      eventTypes.flatMap((stored) => {
        const definition = replayDefinitions.get(stored)
        const logical = definition?.type.toLowerCase().replace(/^session\.next\./, "")
        const matches =
          stored.toLowerCase() === value ||
          logical === normalized ||
          logical?.startsWith(`${normalized}.`) ||
          logical?.includes(`.${normalized}.`) ||
          logical?.endsWith(`.${normalized}`)
        return matches && definition ? [definition.type] : []
      }),
    ),
  ]
}

export function history(
  db: Database,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly cursor?: Event.ID
    readonly anchor?: Event.ID
    readonly direction?: "before" | "after"
    readonly limit: number
  },
) {
  return db
    .transaction((tx) => historyLocked(tx, input), { behavior: "deferred" })
    .pipe(Effect.catch((error) => (error instanceof QueryError ? Effect.fail(error) : Effect.die(error))))
}

function historyLocked(
  db: Database | Transaction,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly cursor?: Event.ID
    readonly anchor?: Event.ID
    readonly direction?: "before" | "after"
    readonly limit: number
  },
) {
  return Effect.gen(function* () {
    const linked = sql`WITH linked AS (
      SELECT e.rowid AS commit_order, e.id
      FROM event AS e
      WHERE e.aggregate_id = ${input.sessionID}
      UNION ALL
      SELECT e.rowid AS commit_order, e.id
      FROM session_task AS task
      INNER JOIN event AS e ON e.aggregate_id = task.id
      WHERE task.root_session_id = ${input.sessionID}
    )`
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Math.floor(input.limit))) : 100
    const readFrom = (
      source: ReturnType<typeof sql>,
      condition: ReturnType<typeof sql>,
      direction: "ASC" | "DESC",
      amount: number,
    ) =>
      db
        .all<ReplayRow>(
          sql`${source}, page AS (
        SELECT id, commit_order
        FROM linked
        WHERE ${condition}
        ORDER BY commit_order ${sql.raw(direction)}
        LIMIT ${amount}
      )
      SELECT e.id, e.aggregate_id, e.seq, e.type, e.data
      FROM page
      INNER JOIN event AS e ON e.id = page.id
      ORDER BY page.commit_order ${sql.raw(direction)}`,
        )
        .pipe(Effect.orDie)
    const read = (condition: ReturnType<typeof sql>, direction: "ASC" | "DESC", amount: number) =>
      readFrom(linked, condition, direction, amount)
    const indexedLinked = sql`WITH linked AS (
      SELECT commit_order, event_id AS id
      FROM ${table}
      WHERE session_id = ${input.sessionID} AND kind = 'event'
    )`
    const coverage = yield* db.get<{ event_before: number; pending: number }>(sql`SELECT
      coalesce((SELECT value FROM session_replay_meta WHERE key = 'event_before'), 0) AS event_before,
      EXISTS(
        SELECT 1
        FROM ${pending} AS queued
        INNER JOIN event AS pending_event ON pending_event.rowid = queued.row_id
        WHERE queued.kind = 'event'
          AND (
            pending_event.aggregate_id = ${input.sessionID}
            OR json_extract(pending_event.data, '$.sessionID') = ${input.sessionID}
            OR EXISTS(
              SELECT 1 FROM session_task AS pending_task
              WHERE pending_task.id = pending_event.aggregate_id
                AND pending_task.root_session_id = ${input.sessionID}
            )
          )
      ) AS pending`)

    if (input.anchor && input.cursor)
      return yield* new QueryError({ message: "Replay history accepts either anchor or cursor", position: 0 })

    if (input.anchor) {
      const indexedAnchor = yield* db.get<{ commit_order: number }>(
        sql`SELECT commit_order FROM ${table}
            WHERE entry_id = ${input.anchor} AND session_id = ${input.sessionID} AND kind = 'event'`,
      )
      const anchor =
        indexedAnchor ??
        (yield* db.get<{ commit_order: number }>(
          sql`${linked} SELECT commit_order FROM linked WHERE id = ${input.anchor}`,
        ))
      if (!anchor) return yield* new QueryError({ message: "Invalid session replay anchor", position: 0 })
      const source = indexedAnchor ? indexedLinked : linked
      const beforeLimit = Math.floor((limit - 1) / 2)
      const afterLimit = limit - beforeLimit
      const indexedBefore = yield* readFrom(source, sql`commit_order < ${anchor.commit_order}`, "DESC", beforeLimit + 1)
      const indexedAfter = yield* readFrom(source, sql`commit_order >= ${anchor.commit_order}`, "ASC", afterLimit + 1)
      const before =
        indexedAnchor && indexedBefore.length <= beforeLimit && (coverage?.event_before ?? 0) > 1
          ? yield* read(sql`commit_order < ${anchor.commit_order}`, "DESC", beforeLimit + 1)
          : indexedBefore
      const after =
        indexedAnchor && indexedAfter.length <= afterLimit && coverage?.pending
          ? yield* read(sql`commit_order >= ${anchor.commit_order}`, "ASC", afterLimit + 1)
          : indexedAfter
      const rows = [...before.slice(0, beforeLimit).reverse(), ...after.slice(0, afterLimit)]
      return {
        events: decodeReplayRows(rows),
        ...(before.length > beforeLimit && rows.at(0) ? { previousCursor: Event.ID.make(rows.at(0)!.id) } : {}),
        ...(after.length > afterLimit && rows.at(-1) ? { nextCursor: Event.ID.make(rows.at(-1)!.id) } : {}),
      } satisfies HistoryPage
    }

    const indexedCursor = input.cursor
      ? yield* db.get<{ commit_order: number }>(
          sql`SELECT commit_order FROM ${table}
              WHERE entry_id = ${input.cursor} AND session_id = ${input.sessionID} AND kind = 'event'`,
        )
      : undefined
    const cursor = input.cursor
      ? (indexedCursor ??
        (yield* db.get<{ commit_order: number }>(
          sql`${linked} SELECT commit_order FROM linked WHERE id = ${input.cursor}`,
        )))
      : undefined
    if (input.cursor && !cursor) return yield* new QueryError({ message: "Invalid session replay cursor", position: 0 })
    const direction = input.direction ?? "after"
    const condition = cursor
      ? direction === "before"
        ? sql`commit_order < ${cursor.commit_order}`
        : sql`commit_order > ${cursor.commit_order}`
      : sql`1`
    const indexedRows = yield* readFrom(
      indexedCursor ? indexedLinked : linked,
      condition,
      direction === "before" ? "DESC" : "ASC",
      limit + 1,
    )
    const rows =
      indexedCursor &&
      indexedRows.length <= limit &&
      ((direction === "before" && (coverage?.event_before ?? 0) > 1) || (direction === "after" && coverage?.pending))
        ? yield* read(
            cursor
              ? direction === "before"
                ? sql`commit_order < ${cursor.commit_order}`
                : sql`commit_order > ${cursor.commit_order}`
              : sql`1`,
            direction === "before" ? "DESC" : "ASC",
            limit + 1,
          )
        : indexedRows
    const page = rows.slice(0, limit)
    if (direction === "before") page.reverse()
    return {
      events: decodeReplayRows(page),
      ...(direction === "before" && rows.length > limit && page.at(0)
        ? { previousCursor: Event.ID.make(page.at(0)!.id) }
        : {}),
      ...(direction === "after" && rows.length > limit && page.at(-1)
        ? { nextCursor: Event.ID.make(page.at(-1)!.id) }
        : {}),
    } satisfies HistoryPage
  })
}

type ReplayRow = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: string | Record<string, unknown>
}

function decodeReplayRows(rows: ReadonlyArray<ReplayRow>) {
  return rows.flatMap((row): ReplayEvent[] => {
    const durable = storedType(row.type)
    if (!durable) return []
    const data = typeof row.data === "string" ? decodeStoredEventData(row.data) : decodeEventData(row.data)
    if (Option.isNone(data)) return []
    return [
      {
        id: Event.ID.make(row.id),
        type: durable.type,
        durable: { aggregateID: row.aggregate_id, seq: row.seq, version: durable.version },
        data: data.value,
      },
    ]
  })
}

function storedType(value: string) {
  const definition = replayDefinitions.get(value)
  if (definition?.durable) return { type: definition.type, version: definition.durable.version }
  const match = value.match(/^(.*)\.(\d+)$/)
  if (!match?.[1] || !match[2]) return
  return { type: match[1], version: Number(match[2]) }
}

function lex(input: string) {
  const tokens: Array<{ value: string; position: number }> = []
  let value = ""
  let start = 0
  let quote = false
  let escaped = false
  const push = () => {
    if (!value) return
    tokens.push({ value, position: start })
    value = ""
  }

  for (let position = 0; position < input.length; position++) {
    const char = input[position]!
    if (escaped) {
      value += char
      escaped = false
      continue
    }
    if (char === "\\" && quote) {
      escaped = true
      continue
    }
    if (char === '"') {
      if (!value) start = position
      quote = !quote
      continue
    }
    if (/\s/.test(char) && !quote) {
      push()
      continue
    }
    if (!value) start = position
    value += char
  }
  if (quote) throw new QueryError({ message: "Unterminated quote", position: input.length })
  if (escaped) value += "\\"
  push()
  return tokens
}

function tokenize(input: string) {
  return [...new Set((input.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, MAX_TERMS))]
}

function parseInstant(value: string, now: number, position: number) {
  const relative = value.toLowerCase().match(/^(\d+)(m|h|d|w)$/)
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2] as "m" | "h" | "d" | "w"]
    return now - Number(relative[1]) * unit
  }
  if (/^\d{10,}$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return parsed
  throw new QueryError({ message: `Invalid replay time: ${value}`, position })
}
