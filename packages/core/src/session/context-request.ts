export * as SessionContextRequest from "./context-request"

import { createHash } from "node:crypto"
import { Message } from "@turenlabs/llm"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionContextBlobTable, SessionContextRequestTable } from "./sql"

export type Entry = { readonly seq: number; readonly message: SessionMessage.Message }
export interface Frame {
  readonly entries: readonly Entry[]
  readonly messages: readonly Message[]
  readonly sources: readonly { seq: number; digest: string }[]
  readonly turn: string
}

export const Frame = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ seq: Schema.Int, message: SessionMessage.Message })),
  messages: Schema.Array(Message),
  sources: Schema.Array(Schema.Struct({ seq: Schema.Int, digest: Schema.String })),
  turn: Schema.String,
})

/**
 * Strings at least this long are stored once in `session_context_blob` and replaced by a reference in the
 * frame row. Frames are ASCII-dominated (base64 data: URIs), so characters approximate bytes.
 */
const externalizeThreshold = 64 * 1024
const refPrefix = "forge-context-blob:sha256:"
// Rows that hold references are wrapped as { [marker]: 1, frame }. Frames have no such key, so rows written
// before externalization, which may contain reference-shaped literals, are never hydrated.
const marker = "forge_context_blobs"
const refPattern = /^forge-context-blob:sha256:([0-9a-f]{64})$/
// Statement variable limits cap IN lists well below SQLite's default.
const chunkSize = 500
const hydratedLimit = 16

/**
 * sha256 by hydrated string for the frame each Session's last prepare returned, so the save that follows reuses
 * references instead of re-hashing multi-megabyte strings. Consumed by save, bounded, and never read for
 * correctness: a miss only costs a hash.
 */
const hydrated = new Map<string, Map<string, string>>()

/**
 * The frame this process last saved for a Session, with the stored row's shape at that moment. The next prepare
 * reads only the row's small columns and its byte size; when they still match it reuses this frame instead of
 * reading, parsing, rehydrating and schema-decoding megabytes it wrote a moment ago. Nothing but `save` writes
 * the row, so a match means the stored frame is the one cached. A miss, including another process having saved,
 * simply loads from the database as before. Bounded to a few Sessions: it holds whole frames.
 */
type Cached = {
  readonly generation: number
  readonly identity: string
  readonly baseline_seq: number
  readonly size: number
  readonly frame: Frame
  readonly known: Map<string, string>
}
const cachedLimit = 4
const cached = new Map<string, Cached>()
const remember = (sessionID: string, value: Cached) => {
  cached.delete(sessionID)
  if (cached.size >= cachedLimit) cached.delete(cached.keys().next().value!)
  cached.set(sessionID, value)
}

export type Reason = "initial" | "baseline" | "configuration" | "history" | "pressure"
type DatabaseService = Database.Interface["db"]

export const prepare = Effect.fn("SessionContextRequest.prepare")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input: { baselineSeq: number; identity: string; history: readonly Entry[] },
) {
  const sources = input.history.map((entry) => ({ seq: entry.seq, digest: digest(entry.message) }))
  const stored = yield* db
    .select({
      generation: SessionContextRequestTable.generation,
      identity: SessionContextRequestTable.identity,
      baseline_seq: SessionContextRequestTable.baseline_seq,
      size: sql<number>`octet_length(${SessionContextRequestTable.data})`,
    })
    .from(SessionContextRequestTable)
    .where(eq(SessionContextRequestTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!stored) {
    cached.delete(sessionID)
    return { generation: 1, reason: "initial" as Reason, frame: undefined, sources }
  }
  const last = cached.get(sessionID)
  // Save removes every blob the frame it writes does not reference, so the Session's blob rows are exactly the
  // cached frame's blobs. A missing one is the same lost-blob case `load` reports, so it must not be a hit.
  const matches =
    last?.generation === stored.generation &&
    last.identity === stored.identity &&
    last.baseline_seq === stored.baseline_seq &&
    last.size === stored.size &&
    (last.known.size === 0 || (yield* blobCount(db, sessionID)) === last.known.size)
  const loaded = matches ? last : yield* load(db, sessionID)
  // A frame that lost a blob cannot be replayed byte-for-byte, so rebuild it like a history change.
  if (loaded === undefined)
    return { generation: stored.generation + 1, reason: "history" as Reason, frame: undefined, sources }
  const frame = loaded.frame
  const reason: Reason | undefined =
    stored.baseline_seq !== input.baselineSeq
      ? "baseline"
      : stored.identity !== input.identity
        ? "configuration"
        : frame.sources.some((source, index) => {
              const current = sources[index]
              return current?.seq !== source.seq || current.digest !== source.digest
            })
          ? "history"
          : undefined
  if (reason === undefined && loaded.known.size > 0) {
    hydrated.delete(sessionID)
    if (hydrated.size >= hydratedLimit) hydrated.delete(hydrated.keys().next().value!)
    hydrated.set(sessionID, loaded.known)
  }
  return {
    generation: stored.generation + (reason === undefined ? 0 : 1),
    reason,
    frame: reason === undefined ? frame : undefined,
    sources,
  }
})

type Part = { readonly value: unknown; readonly blobs: ReadonlyMap<string, string> }
const entryParts = new WeakMap<SessionMessage.Message, Part>()
const messageParts = new WeakMap<Message, Part>()
const encodeEntryMessage = Schema.encodeSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(Message)

const rewritten = (encoded: unknown, externalize: (into: Map<string, string>) => (value: string) => string): Part => {
  const blobs = new Map<string, string>()
  return { value: rewrite(encoded, externalize(blobs)), blobs }
}

const blobCount = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({ count: sql<number>`count(*)` })
    .from(SessionContextBlobTable)
    .where(eq(SessionContextBlobTable.session_id, sessionID))
    .get()
    .pipe(
      Effect.map((row) => row?.count ?? 0),
      Effect.orDie,
    )

/** Reads, rehydrates and decodes the stored frame; undefined when a referenced blob is gone. */
const load = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const stored = yield* db
    .select({ data: SessionContextRequestTable.data })
    .from(SessionContextRequestTable)
    .where(eq(SessionContextRequestTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!stored) return undefined
  const data: unknown = stored.data
  const envelope = typeof data === "object" && data !== null && marker in data && "frame" in data ? data : undefined
  const wrapped = envelope !== undefined
  const body = envelope ? envelope.frame : data
  const refs = new Set<string>()
  if (wrapped)
    rewrite(body, (value) => {
      const sha256 = refPattern.exec(value)?.[1]
      if (sha256) refs.add(sha256)
      return value
    })
  const blobs = new Map<string, string>()
  const shas = [...refs]
  for (let index = 0; index < shas.length; index += chunkSize) {
    const rows = yield* db
      .select({ sha256: SessionContextBlobTable.sha256, data: SessionContextBlobTable.data })
      .from(SessionContextBlobTable)
      .where(
        and(
          eq(SessionContextBlobTable.session_id, sessionID),
          inArray(SessionContextBlobTable.sha256, shas.slice(index, index + chunkSize)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) blobs.set(row.sha256, row.data)
  }
  if (blobs.size < refs.size) return undefined
  const frame = yield* Schema.decodeUnknownEffect(Frame)(
    wrapped
      ? rewrite(body, (value) => {
          const sha256 = refPattern.exec(value)?.[1]
          return sha256 ? blobs.get(sha256)! : value
        })
      : body,
  ).pipe(Effect.orDie)
  return { frame, known: new Map([...blobs].map(([sha256, value]) => [value, sha256])) }
})

export const save = Effect.fn("SessionContextRequest.save")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input: { baselineSeq: number; identity: string; generation: number; reason?: Reason; frame: Frame },
) {
  const known = hydrated.get(sessionID)
  hydrated.delete(sessionID)
  const blobs = new Map<string, string>()
  const externalize = (into: Map<string, string>) => (value: string) => {
    // A short string shaped like a reference is externalized too, so hydration never mistakes it for one.
    if (value.length < externalizeThreshold && !refPattern.test(value)) return value
    // Hashing and SQLite text binding replace lone surrogates, so such strings stay inline, where JSON escapes them.
    if (!value.isWellFormed()) return value
    const sha256 = known?.get(value) ?? createHash("sha256").update(value).digest("hex")
    into.set(sha256, value)
    return refPrefix + sha256
  }
  // A frame is its previous frame plus a few messages, so each message is encoded and rewritten once and the
  // result reused for as long as the message object lives. Encoding the whole frame every turn was a full copy,
  // and a second full copy to rewrite it, of history that had not changed.
  const part = <T extends object>(memo: WeakMap<T, Part>, item: T, encode: (item: T) => unknown) => {
    const hit = memo.get(item)
    const reused = hit ?? rewritten(encode(item), externalize)
    if (!hit) memo.set(item, reused)
    if (reused.blobs.size > 0) for (const [sha256, value] of reused.blobs) blobs.set(sha256, value)
    return reused.value
  }
  const data = {
    entries: input.frame.entries.map((entry) => ({
      seq: entry.seq,
      message: part(entryParts, entry.message, encodeEntryMessage),
    })),
    messages: input.frame.messages.map((message) => part(messageParts, message, encodeMessage)),
    // Digests are 64 hex characters and the turn is a message ID: neither can reach the externalization
    // threshold or look like a blob reference, so copying them through `rewrite` only allocates.
    sources: input.frame.sources,
    turn: input.frame.turn,
  }
  const values = {
    data: blobs.size > 0 ? { [marker]: 1, frame: data } : data,
    generation: input.generation,
    identity: input.identity,
    baseline_seq: input.baselineSeq,
  }
  yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const stored = new Set(
          (yield* db
            .select({ sha256: SessionContextBlobTable.sha256 })
            .from(SessionContextBlobTable)
            .where(eq(SessionContextBlobTable.session_id, sessionID))
            .all()).map((row) => row.sha256),
        )
        const added = [...blobs].filter(([sha256]) => !stored.has(sha256))
        for (const [sha256, value] of added)
          yield* db
            .insert(SessionContextBlobTable)
            .values({ session_id: sessionID, sha256, data: value, size: Buffer.byteLength(value) })
            .run()
        yield* db
          .insert(SessionContextRequestTable)
          .values({ session_id: sessionID, ...values, reason: input.reason ?? "initial" })
          .onConflictDoUpdate({
            target: SessionContextRequestTable.session_id,
            // Stable appends retain the last rebuild reason for inspection.
            set: { ...values, ...(input.reason === undefined ? {} : { reason: input.reason }) },
          })
          .run()
        // Only blobs the frame just written no longer references are removed.
        const orphans = [...stored].filter((sha256) => !blobs.has(sha256))
        for (let index = 0; index < orphans.length; index += chunkSize)
          yield* db
            .delete(SessionContextBlobTable)
            .where(
              and(
                eq(SessionContextBlobTable.session_id, sessionID),
                inArray(SessionContextBlobTable.sha256, orphans.slice(index, index + chunkSize)),
              ),
            )
            .run()
      }),
    )
    .pipe(Effect.orDie)
  const written = yield* db
    .select({ size: sql<number>`octet_length(${SessionContextRequestTable.data})` })
    .from(SessionContextRequestTable)
    .where(eq(SessionContextRequestTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (written)
    remember(sessionID, {
      generation: input.generation,
      identity: input.identity,
      baseline_seq: input.baselineSeq,
      size: written.size,
      frame: input.frame,
      known: new Map([...blobs].map(([sha256, value]) => [value, sha256])),
    })
})


/** Copies JSON-shaped data with every string leaf passed through `map`; object keys and other values are kept. */
function rewrite(value: unknown, map: (value: string) => string): unknown {
  if (typeof value === "string") return map(value)
  if (Array.isArray(value)) return value.map((item) => rewrite(item, map))
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, map)]))
}

// A message's digest only changes when the message does, and a changed message is a new object (decoded rows are
// replaced, never edited in place), so identity is a sound key. Without this, every turn re-encodes and re-hashes
// the whole history to learn that nothing before the newest messages moved.
const digests = new WeakMap<SessionMessage.Message, string>()

function digest(message: SessionMessage.Message) {
  const known = digests.get(message)
  if (known !== undefined) return known
  const value = computeDigest(message)
  digests.set(message, value)
  return value
}

function computeDigest(message: SessionMessage.Message) {
  const encoded = Schema.encodeSync(SessionMessage.Message)(message)
  // Pruning marks durable raw history after rendering; it must not rewrite a saved prefix.
  const value =
    encoded.type !== "assistant"
      ? encoded
      : {
          ...encoded,
          content: encoded.content.map((part) =>
            part.type === "tool" ? { ...part, time: { ...part.time, pruned: undefined } } : part,
          ),
        }
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
