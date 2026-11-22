export * as SessionLeanMessage from "./lean-message"

import { SessionMessage } from "./message"

/**
 * `session.messages` pages ship every tool body by default; on a tool-heavy transcript that is
 * tens of MiB of `content`/`structured` the renderer parses before the first row paints — and most
 * of it is only ever read when the user expands the card (228.7 MiB across 1952 messages in the
 * measured "Revamp V2" session, 81% of it in 3% of messages). `?lean=true` replaces oversized tool
 * bodies with a `truncated` marker; the full row stays available through `session.message`, which
 * the timeline fetches on expand.
 */
export const LeanToolBodyBytes = 64 * 1024
// `structured` is kept whole when it is itself small: collapsed cards still read scalars out of it
// (a shell's `exit`/`timeout`), and those are never the payload being trimmed.
const LeanStructuredKeepBytes = 256

const byteSize = (value: unknown) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8"))
const TextEnvelopeBytes = byteSize([{ type: "text", text: "" }]) + byteSize({ type: "text", value: "" }) - 4

function leanToolContent(item: SessionMessage.AssistantContent, elided: number): SessionMessage.AssistantContent {
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
  const bytes = elided + bodyBytes + structuredBytes + byteSize("attachments" in state ? state.attachments : undefined)
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

export function trim(message: SessionMessage.Message, elided?: ReadonlyMap<number, number>): SessionMessage.Message {
  if (message.type !== "assistant") return message
  let trimmed = false
  const content = message.content.map((item, index) => {
    const next = leanToolContent(item, elided?.get(index) ?? 0)
    trimmed ||= next !== item
    return next
  })
  return trimmed ? { ...message, content } : message
}
