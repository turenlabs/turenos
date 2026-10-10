import { content, id, json, key, record, string } from "./guards"
import { MAX_TEXT, type Assistant, type Change, type Data, type Overlay, type Part } from "./types"

type Effect = { next: Part; ended: boolean }
type Kind = Part["type"]

const PART_EVENT =
  /^session\.next\.(text|reasoning|tool)(?:\.(input))?\.(started|delta|ended|called|progress|success|failed)$/

/** A text, reasoning or tool event applied to the message it belongs to. */
export function partChange(
  type: string,
  d: Data,
  info: Assistant,
  current: Overlay | undefined,
  stored: Assistant | undefined,
  settled: boolean,
): Change | undefined {
  const match = PART_EVENT.exec(type)
  if (!match) return
  const kind = match[1] as Kind
  const input = match[2] === "input"
  const action = match[3]!
  if (
    (kind !== "tool" && input) ||
    (kind !== "tool" && !["started", "delta", "ended"].includes(action)) ||
    (kind === "tool" && input !== ["started", "delta", "ended"].includes(action))
  )
    return
  const partID = d[kind === "text" ? "textID" : kind === "reasoning" ? "reasoningID" : "callID"]
  if (!id(partID)) return
  const partKey = `${kind}:${partID}`
  const existing = current?.parts.get(partKey)
  const previous = existing?.part ?? stored?.content.find((part) => key(part) === partKey)
  if (existing?.ended && action !== "ended") return
  const effect =
    action === "started"
      ? started(kind, partID, d, previous, settled)
      : action === "delta" || action === "ended"
        ? streamed(kind, action, partID, d, previous, settled)
        : lifecycle(action, d, previous)
  if (!effect) return
  return { info, settled, next: effect.next, ended: effect.ended, partKey }
}

function started(
  kind: Kind,
  partID: string,
  d: Data,
  previous: Part | undefined,
  settled: boolean,
): Effect | undefined {
  if (previous || settled) return
  if (kind === "tool") {
    if (!string(d.name)) return
    return {
      ended: false,
      next: {
        type: "tool",
        id: partID,
        name: d.name,
        time: { created: d.timestamp },
        state: { status: "pending", input: "" },
      },
    }
  }
  return {
    ended: false,
    next:
      kind === "text"
        ? { type: kind, id: partID, text: "" }
        : { type: kind, id: partID, text: "", time: { created: d.timestamp } },
  }
}

/** Text appended by a delta, or replaced by the full value an `ended` event carries. */
function streamed(
  kind: Kind,
  action: "delta" | "ended",
  partID: string,
  d: Data,
  previous: Part | undefined,
  settled: boolean,
): Effect | undefined {
  const value = action === "delta" ? d.delta : d.text
  if (!string(value) || (action === "delta" && (!previous || settled))) return
  // Never pin a truncated completion over a later full snapshot.
  if (action === "ended" && kind !== "tool" && value.length > MAX_TEXT) return
  const ended = action === "ended" && kind !== "tool"
  if (kind === "tool") {
    if (previous?.type !== "tool" || previous.state.status !== "pending") return
    return {
      ended,
      next: {
        ...previous,
        state: {
          status: "pending",
          input: (action === "ended" ? value : previous.state.input + value).slice(0, MAX_TEXT),
        },
      },
    }
  }
  if (previous?.type === "tool") return
  const text = (action === "ended" ? value : (previous?.text ?? "") + value).slice(0, MAX_TEXT)
  return {
    ended,
    next:
      kind === "text"
        ? { type: kind, id: partID, text }
        : {
            type: kind,
            id: partID,
            text,
            time: {
              created: previous?.type === "reasoning" ? (previous.time?.created ?? d.timestamp) : d.timestamp,
              ...(action === "ended" ? { completed: d.timestamp } : {}),
            },
          },
  }
}

/** Tool call lifecycle: called, progress, success and failed. */
function lifecycle(action: string, d: Data, previous: Part | undefined): Effect | undefined {
  if (previous?.type !== "tool") return
  const state = previous.state
  if (state.status === "completed" || state.status === "error") return
  if (action !== "progress" && (!record(d.provider) || typeof d.provider.executed !== "boolean")) return
  const executed = (d.provider as { executed: boolean } | undefined)?.executed
  if (action === "called") {
    if (state.status !== "pending" || !string(d.tool) || !record(d.input) || !json(d.input)) return
    return {
      ended: false,
      next: {
        ...previous,
        name: d.tool,
        provider: { executed: executed! },
        time: { ...previous.time, ran: d.timestamp },
        state: { status: "running", input: d.input, structured: {}, content: [] },
      },
    }
  }
  if (action === "progress" || action === "success") {
    if (state.status !== "running" || !record(d.structured) || !json(d.structured) || !content(d.content)) return
    return {
      ended: action === "success",
      next: {
        ...previous,
        state: {
          status: action === "progress" ? "running" : "completed",
          input: state.input,
          structured: d.structured,
          content: d.content,
        },
        ...(action === "success"
          ? {
              time: { ...previous.time, completed: d.timestamp },
              provider: { executed: executed! || previous.provider?.executed === true },
            }
          : {}),
      },
    }
  }
  if (action !== "failed") return
  if (!record(d.error) || d.error.type !== "unknown" || !string(d.error.message)) return
  return {
    ended: true,
    next: {
      ...previous,
      time: { ...previous.time, completed: d.timestamp },
      provider: { executed: executed! || previous.provider?.executed === true },
      state: {
        status: "error",
        input: state.status === "pending" ? {} : state.input,
        structured: state.status === "pending" ? {} : state.structured,
        content: state.status === "pending" ? [] : state.content,
        error: { type: "unknown", message: d.error.message },
      },
    },
  }
}
