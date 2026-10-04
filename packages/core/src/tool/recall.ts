export * as RecallTool from "./recall"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionReplay } from "../session/replay"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const name = "session_recall"

/** Search results are previews, so a page of them is cheap. */
const DEFAULT_MATCHES = 8
const MAX_MATCHES = 25
/** Reading returns whole event payloads, so keep the window small and each event bounded. */
const DEFAULT_EVENTS = 10
const MAX_EVENTS = 30
const PREVIEW_CHARS = 400
const EVENT_CHARS = 1_200

const Input = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description:
        "Words to find in this session's earlier history, plus optional filters: tool:bash, path:src/app.ts, type:tool, call:<call id>, has:error, status:failed, after:2h, before:2026-10-01. Matches the start and end of each event, not the middle of a very large output. Do not use session:.",
    }),
  ),
  around: Schema.optional(
    Schema.String.annotate({
      description:
        "An event id from a search result, or a before/after id from a previous read. Returns the events around it in order, with their content. Use this instead of query to read.",
    }),
  ),
  cursor: Schema.optional(Schema.String.annotate({ description: "next_cursor from the previous search, for more results." })),
  limit: Schema.optional(
    Schema.Number.annotate({
      description: `How many to return. Searches default to ${DEFAULT_MATCHES} (max ${MAX_MATCHES}); reads default to ${DEFAULT_EVENTS} (max ${MAX_EVENTS}).`,
    }),
  ),
})

const Output = Schema.Struct({
  mode: Schema.Literals(["search", "read"]),
  /** True while the search index is still being built, so results may be incomplete. */
  indexing: Schema.optional(Schema.Boolean),
  total: Schema.optional(Schema.Number),
  matches: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        time: Schema.String,
        message: Schema.optional(Schema.String),
        preview: Schema.String,
      }),
    ),
  ),
  next_cursor: Schema.optional(Schema.String),
  events: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.Number, type: Schema.String, content: Schema.String })),
  ),
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
})

/** Keeps the start and the end, where a command and its result or error usually are. */
export const clip = (text: string, max: number) => {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.65)
  const tail = max - head
  return `${text.slice(0, head)} … ${text.length - max} characters omitted … ${text.slice(text.length - tail)}`
}

const bound = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const database = yield* Database.Service
    const db = Database.primary(database.db)

    const failure = (error: { readonly message: string }) => new ToolFailure({ message: error.message })

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Search or read this session's own earlier history, including what compaction removed from your context. The full history stays stored: after a checkpoint, use this to recover an exact command, error, path or decision instead of guessing. It only ever sees this session. Two moves: pass \`query\` to find events (each result has an id), then pass \`around\` with an id to read the events around it, in order, with their content.`,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if ((input.query === undefined) === (input.around === undefined))
                return yield* new ToolFailure({ message: "Pass exactly one of query (to search) or around (to read)." })

              // The same preparation the replay search takes before it runs: the index is created and turned on
              // lazily, and a batch is drained so recent events are findable.
              yield* SessionReplay.ensure(db).pipe(Effect.orDie)
              yield* SessionReplay.enable(db).pipe(Effect.orDie)
              yield* SessionReplay.backfillBatch(db).pipe(Effect.orDie)

              if (input.around !== undefined) {
                // A malformed id is the model's mistake to correct, not a defect.
                const anchor = yield* Schema.decodeUnknownEffect(EventV2.ID)(input.around).pipe(
                  Effect.mapError(
                    () => new ToolFailure({ message: "around must be an event id from a search result; it starts with evt_." }),
                  ),
                )
                const page = yield* SessionReplay.history(db, {
                  sessionID: context.sessionID,
                  anchor,
                  limit: bound(input.limit, DEFAULT_EVENTS, MAX_EVENTS),
                }).pipe(Effect.mapError(failure))
                return {
                  mode: "read" as const,
                  events: page.events.map((event) => ({
                    id: String(event.id),
                    seq: event.durable.seq,
                    type: event.type,
                    content: clip(JSON.stringify(event.data), EVENT_CHARS),
                  })),
                  ...(page.previousCursor ? { before: String(page.previousCursor) } : {}),
                  ...(page.nextCursor ? { after: String(page.nextCursor) } : {}),
                }
              }

              const query = input.query!.trim()
              if (query.length === 0) return yield* new ToolFailure({ message: "query cannot be empty." })
              // Search covers every session, so scope is enforced here and not left to the caller: a `session:`
              // filter is rejected, and ours is prepended.
              const parsed = yield* Effect.try({
                try: () => SessionReplay.parse(query),
                catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : "Invalid query" }),
              })
              if (parsed.filters.some((filter) => filter.field === "session"))
                return yield* new ToolFailure({
                  message: "This tool only searches the current session. Remove the session: filter.",
                })
              const page = yield* SessionReplay.search(db, {
                query: `session:${context.sessionID} ${query}`,
                limit: bound(input.limit, DEFAULT_MATCHES, MAX_MATCHES),
                cursor: input.cursor,
              }).pipe(Effect.mapError(failure))
              return {
                mode: "search" as const,
                ...(page.index.status === "indexing" ? { indexing: true } : {}),
                total: page.total,
                matches: page.entries.flatMap((entry) =>
                  entry.kind === "event" && entry.event
                    ? [
                        {
                          id: String(entry.event.id),
                          type: entry.event.type,
                          time: new Date(entry.event.timestamp).toISOString(),
                          ...(entry.event.messageID ? { message: String(entry.event.messageID) } : {}),
                          preview: clip(entry.event.preview, PREVIEW_CHARS),
                        },
                      ]
                    : [],
                ),
                ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/recall",
  layer,
  deps: [ToolRegistry.node, Database.node],
})
