import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionV2 } from "@turenlabs/core/session"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidCursorError, InvalidRequestError, SessionNotFoundError, UnknownError } from "@turenlabs/protocol/errors"

const DefaultMessagesLimit = 50

/**
 * `session.messages` pages ship every tool body by default; on a tool-heavy transcript that is
 * tens of MiB of `content`/`structured` the renderer parses before the first row paints — and most
 * of it is only ever read when the user expands the card (228.7 MiB across 1952 messages in the
 * measured "Revamp V2" session, 81% of it in 3% of messages). `?lean=true` replaces oversized tool
 * bodies with a `truncated` marker; the full row stays available through `session.message`, which
 * the timeline fetches on expand.
 */
const LeanToolBodyBytes = 64 * 1024
// `structured` is kept whole when it is itself small: collapsed cards still read scalars out of it
// (a shell's `exit`/`timeout`), and those are never the payload being trimmed.
const LeanStructuredKeepBytes = 256

const byteSize = (value: unknown) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8"))
const TextEnvelopeBytes = byteSize([{ type: "text", text: "" }]) + byteSize({ type: "text", value: "" }) - 4

function leanToolContent(item: SessionMessage.AssistantContent): SessionMessage.AssistantContent {
  // Only settled states truncate: a pending call has no body yet and a running one's streamed
  // output is what the timeline is live-rendering — eliding it would blank the open card.
  if (item.type !== "tool" || (item.state.status !== "completed" && item.state.status !== "error")) return item
  const state = item.state
  const output = state.content.length === 1 ? state.content[0] : undefined
  const result = state.result
  // ToolOutput.toResultValue repeats a single text part in the result. Count
  // the escaped text once while keeping both envelopes in the wire byte count.
  const bodyBytes =
    output?.type === "text" &&
    output.text.length >= LeanToolBodyBytes / 4 &&
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === "text" &&
    "value" in result &&
    result.value === output.text &&
    Object.keys(result).length === 2
      ? 2 * byteSize(output.text) + TextEnvelopeBytes
      : byteSize(state.content) + byteSize(result)
  const structuredBytes = byteSize(state.structured)
  const bytes = bodyBytes + structuredBytes + byteSize("attachments" in state ? state.attachments : undefined)
  if (bytes <= LeanToolBodyBytes) return item
  const structured = structuredBytes <= LeanStructuredKeepBytes ? state.structured : {}
  return {
    ...item,
    truncated: { bytes },
    state: {
      ...state,
      content: [],
      structured,
      // `result` and `attachments` re-carry the same bytes (`ToolOutput.toResultValue` rebuilds
      // content into `result`); they go with the body they duplicate.
      ...(state.status === "completed" ? { result: undefined, attachments: undefined } : {}),
      ...(state.status === "error" ? { result: undefined } : {}),
    },
  }
}

export function leanSessionMessage(message: SessionMessage.Message): SessionMessage.Message {
  if (message.type !== "assistant") return message
  let trimmed = false
  const content = message.content.map((item) => {
    const next = leanToolContent(item)
    trimmed ||= next !== item
    return next
  })
  return trimmed ? { ...message, content } : message
}

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownSync(Cursor)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = yield* Effect.try({
          try: () => (ctx.query.cursor ? cursor.decode(ctx.query.cursor) : undefined),
          catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
        })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const messages = yield* session
          .messages({
            sessionID: ctx.params.sessionID,
            limit: ctx.query.limit ?? DefaultMessagesLimit,
            order,
            cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
          })
          .pipe(
            Effect.catchTag(
              "SessionTranscriptAdoption.AdoptionError",
              (error) => new InvalidRequestError({ kind: "session_transcript_adoption", message: error.message }),
            ),
            Effect.catchTag(
              "SessionLegacyExecution.QuiescenceUnavailableError",
              (error) =>
                new InvalidRequestError({
                  kind: "session_transcript_adoption",
                  message: `Legacy session execution could not be stopped safely: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.MessageDecodeError", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to decode session message").pipe(
                Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                  ),
                ),
              )
            }),
          )
        const first = messages[0]
        const last = messages.at(-1)
        return {
          data: ctx.query.lean ? messages.map(leanSessionMessage) : messages,
          cursor: {
            previous: first ? cursor.encode(first, order, "previous") : undefined,
            next: last ? cursor.encode(last, order, "next") : undefined,
          },
        }
      }),
    )
  }),
)
