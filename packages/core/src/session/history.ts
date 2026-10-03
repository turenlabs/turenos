import { and, asc, desc, eq, gt, ne, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

// Decoded messages are immutable once landed, and every write path changes the
// stored JSON text, so the raw column text is a safe content discriminator. A
// cache hit skips both the JSON.parse and the schema decode that otherwise run
// for every row on every drain — the dominant allocation cost on long sessions.
const decodeCache = new Map<SessionMessage.ID, { data: string; message: SessionMessage.Message }>()
const DECODE_CACHE_LIMIT = 8192

export const decodeStats = { hits: 0, misses: 0 }

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  const throughSeq =
    typeof row.data === "object" && row.data !== null && "throughSeq" in row.data ? row.data.throughSeq : undefined
  const reason = typeof row.data === "object" && row.data !== null && "reason" in row.data ? row.data.reason : undefined
  return {
    id: row.id,
    seq: row.seq,
    throughSeq: typeof throughSeq === "number" && Number.isSafeInteger(throughSeq) ? throughSeq : undefined,
    reason: reason === "auto" || reason === "manual" ? reason : undefined,
  }
})

export const needsContinuation = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const compaction = yield* latestCompaction(db, sessionID)
  if (compaction?.reason !== "auto") return false
  const assistant = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, compaction.seq),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return assistant === undefined
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly id: SessionMessage.ID; readonly seq: number; readonly throughSeq?: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      session_id: SessionMessageTable.session_id,
      type: SessionMessageTable.type,
      seq: SessionMessageTable.seq,
      data: sql<string>`${SessionMessageTable.data}`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              eq(SessionMessageTable.id, compaction.id),
              and(
                ne(SessionMessageTable.type, "compaction"),
                gt(SessionMessageTable.seq, compaction.throughSeq ?? compaction.seq),
              ),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  if (!compaction || compaction.throughSeq === undefined) return rows
  // Preserved rows were committed before the checkpoint event, but model history is checkpoint
  // first, then the original structured tail it did not summarize.
  const checkpoint = rows.find((row) => row.id === compaction.id)
  return checkpoint ? [checkpoint, ...rows.filter((row) => row.id !== compaction.id)] : rows
})

type MessageRow = {
  id: SessionMessage.ID
  session_id: string
  type: SessionMessage.Type
  seq: number
  data: string
}

const decodeMessageRow = (row: MessageRow) => {
  const cached = decodeCache.get(row.id)
  if (cached !== undefined && cached.data === row.data) {
    decodeStats.hits++
    return Effect.succeed(cached.message)
  }
  decodeStats.misses++
  return decode({ ...JSON.parse(row.data), id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
    Effect.tap((message) =>
      Effect.sync(() => {
        if (decodeCache.size >= DECODE_CACHE_LIMIT) {
          // Map iterates in insertion order, so the leading keys are the oldest reads.
          let drop = Math.ceil(DECODE_CACHE_LIMIT / 10)
          for (const key of decodeCache.keys()) {
            if (drop-- <= 0) break
            decodeCache.delete(key)
          }
        }
        decodeCache.set(row.id, { data: row.data, message })
      }),
    ),
  )
}

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* entries(db, sessionID)).map((entry) => entry.message)
})

export const entries = Effect.fn("SessionHistory.entries")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  const rows = yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq)
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export * as SessionHistory from "./history"
