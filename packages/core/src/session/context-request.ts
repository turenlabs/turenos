export * as SessionContextRequest from "./context-request"

import { createHash } from "node:crypto"
import { Message } from "@turenlabs/llm"
import { and, eq, inArray } from "drizzle-orm"
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

export type Reason = "initial" | "baseline" | "configuration" | "history" | "pressure"
type DatabaseService = Database.Interface["db"]

export const prepare = Effect.fn("SessionContextRequest.prepare")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input: { baselineSeq: number; identity: string; history: readonly Entry[] },
) {
  const sources = input.history.map((entry) => ({ seq: entry.seq, digest: digest(entry.message) }))
  const stored = yield* db
    .select()
    .from(SessionContextRequestTable)
    .where(eq(SessionContextRequestTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!stored) return { generation: 1, reason: "initial" as Reason, frame: undefined, sources }

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
  // A frame that lost a blob cannot be replayed byte-for-byte, so rebuild it like a history change.
  if (blobs.size < refs.size)
    return { generation: stored.generation + 1, reason: "history" as Reason, frame: undefined, sources }

  const frame = yield* Schema.decodeUnknownEffect(Frame)(
    wrapped
      ? rewrite(body, (value) => {
          const sha256 = refPattern.exec(value)?.[1]
          return sha256 ? blobs.get(sha256)! : value
        })
      : body,
  ).pipe(Effect.orDie)
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
  if (reason === undefined && blobs.size > 0) {
    hydrated.delete(sessionID)
    if (hydrated.size >= hydratedLimit) hydrated.delete(hydrated.keys().next().value!)
    hydrated.set(sessionID, new Map([...blobs].map(([sha256, value]) => [value, sha256])))
  }
  return {
    generation: stored.generation + (reason === undefined ? 0 : 1),
    reason,
    frame: reason === undefined ? frame : undefined,
    sources,
  }
})

export const save = Effect.fn("SessionContextRequest.save")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input: { baselineSeq: number; identity: string; generation: number; reason?: Reason; frame: Frame },
) {
  const encoded = yield* Schema.encodeEffect(Frame)(input.frame).pipe(Effect.orDie)
  const known = hydrated.get(sessionID)
  hydrated.delete(sessionID)
  const blobs = new Map<string, string>()
  const data = rewrite(encoded, (value) => {
    // A short string shaped like a reference is externalized too, so hydration never mistakes it for one.
    if (value.length < externalizeThreshold && !refPattern.test(value)) return value
    // Hashing and SQLite text binding replace lone surrogates, so such strings stay inline, where JSON escapes them.
    if (!value.isWellFormed()) return value
    const sha256 = known?.get(value) ?? createHash("sha256").update(value).digest("hex")
    blobs.set(sha256, value)
    return refPrefix + sha256
  })
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
})

/** Copies JSON-shaped data with every string leaf passed through `map`; object keys and other values are kept. */
function rewrite(value: unknown, map: (value: string) => string): unknown {
  if (typeof value === "string") return map(value)
  if (Array.isArray(value)) return value.map((item) => rewrite(item, map))
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, map)]))
}

function digest(message: SessionMessage.Message) {
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
