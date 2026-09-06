export * as SessionContextRequest from "./context-request"

import { createHash } from "node:crypto"
import { Message } from "@turenlabs/llm"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionContextRequestTable } from "./sql"

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

  const frame = yield* Schema.decodeUnknownEffect(Frame)(stored.data).pipe(Effect.orDie)
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
  const data = yield* Schema.encodeEffect(Frame)(input.frame).pipe(Effect.orDie)
  const values = {
    data,
    generation: input.generation,
    identity: input.identity,
    baseline_seq: input.baselineSeq,
  }
  yield* db
    .insert(SessionContextRequestTable)
    .values({ session_id: sessionID, ...values, reason: input.reason ?? "initial" })
    .onConflictDoUpdate({
      target: SessionContextRequestTable.session_id,
      // Stable appends retain the last rebuild reason for inspection.
      set: { ...values, ...(input.reason === undefined ? {} : { reason: input.reason }) },
    })
    .run()
    .pipe(Effect.orDie)
})

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
