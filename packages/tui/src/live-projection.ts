import type { JsonValue, MessagesListOutput } from "@turenlabs/client"
import type { Session } from "./server"

export type LiveEvent = { id: string; type: string; data: unknown; durable?: unknown }
type Messages = MessagesListOutput["data"]
type Assistant = Extract<Messages[number], { type: "assistant" }>
type Part = Assistant["content"][number]
type Tool = Extract<Part, { type: "tool" }>
type Overlay = {
  info: Assistant
  settled: boolean
  parts: Map<string, { part: Part; ended: boolean; snapshot?: Part; changed?: boolean }>
}

const MAX_MESSAGES = 30
const MAX_PARTS = 128
const MAX_TEXT = 65_536
const MAX_EVENTS = 4096
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === "string"
const id = (value: unknown): value is string => string(value) && value.length > 0 && value.length <= 512
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const key = (part: Part) => `${part.type}:${part.id}`

// Bound traversal as well as retained strings/objects. SSE payloads are JSON, not class instances.
function json(value: unknown): value is JsonValue {
  let budget = 262_144
  let nodes = 8192
  function visit(item: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 16) return false
    if (item === null || typeof item === "boolean" || finite(item)) return true
    if (string(item)) return (budget -= item.length) >= 0
    if (Array.isArray(item)) return item.length <= 8192 && item.every((entry) => visit(entry, depth + 1))
    if (!record(item) || Object.getPrototypeOf(item) !== Object.prototype) return false
    return Object.entries(item).every(([name, entry]) => (budget -= name.length) >= 0 && visit(entry, depth + 1))
  }
  return visit(value, 0)
}

function content(value: unknown): value is Extract<Tool["state"], { status: "running" }>["content"] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) =>
        record(item) &&
        ((item.type === "text" && string(item.text) && item.text.length <= MAX_TEXT) ||
          (item.type === "file" &&
            string(item.uri) &&
            string(item.mime) &&
            (item.name === undefined || string(item.name)))),
    )
  )
}

/**
 * Snapshot inputs have already passed the client's response validation.
 * A live cursor is anchored once, never advanced by a later snapshot. Presentation
 * chooses the longer prefix-compatible value; full ended values always replace it.
 * There is no protocol offset tying GET to SSE: orphan deltas are dropped, and
 * conflicting (non-prefix) snapshots win presentation until a full ended value.
 * The caller must establish its initial GET/SSE ordering and recreate on reconnect.
 * Limits apply to live overlays, not to the caller's validated history page.
 */
export function createLiveProjection(session: Session) {
  let base: Messages = []
  const active = new Map<string, Overlay>()
  const seen = new Set<string>()
  let partCount = 0

  function room() {
    if (active.size < MAX_MESSAGES) return
    const oldest = active.keys().next().value
    if (oldest === undefined) return
    partCount -= active.get(oldest)!.parts.size
    active.delete(oldest)
  }

  function messages(): Messages {
    const result: Messages[number][] = []
    const included = new Set<string>()
    function merge(info: Assistant, overlay: Overlay): Assistant {
      const used = new Set<string>()
      const parts = info.content.map((original) => {
        let part = original
        const name = key(part)
        used.add(name)
        const live = overlay.parts.get(name)
        if (!live) return part
        if (live.ended) return live.part
        part = live.snapshot ?? part
        if (part.type !== "tool" && live.part.type !== "tool") {
          return live.part.text.startsWith(part.text) ? live.part : part
        }
        if (part.type === "tool" && live.part.type === "tool") {
          const rank = { pending: 0, running: 1, completed: 2, error: 2 }
          if (rank[part.state.status] > rank[live.part.state.status]) return part
          if (part.state.status === "pending" && live.part.state.status === "pending") {
            return live.part.state.input.startsWith(part.state.input) ? live.part : part
          }
        }
        return live.part
      })
      for (const [name, live] of overlay.parts) if (!used.has(name)) parts.push(live.part)
      return { ...info, ...(overlay.settled ? overlay.info : {}), content: parts }
    }
    for (const message of base) {
      included.add(message.id)
      const overlay = active.get(message.id)
      result.push(message.type === "assistant" && overlay ? merge(message, overlay) : message)
    }
    for (const [messageID, overlay] of active) {
      if (!included.has(messageID)) result.push(merge(overlay.info, overlay))
    }
    return result
  }

  function snapshot(input: Messages): Messages {
    base = input
    // Seed only incomplete recent messages. Existing cursors must not move when GET is ahead.
    for (const message of input.slice(-MAX_MESSAGES)) {
      if (message.type !== "assistant") continue
      if (message.time.completed !== undefined) {
        const completed = active.get(message.id)
        if (completed) {
          partCount -= completed.parts.size
          active.delete(message.id)
        }
        continue
      }
      let overlay = active.get(message.id)
      if (!overlay) {
        room()
        overlay = { info: { ...message, content: [] }, settled: false, parts: new Map() }
        active.set(message.id, overlay)
      }
      for (const part of message.content) {
        const existing = overlay.parts.get(key(part))
        if (existing) {
          const prior = existing.snapshot
          if (part.type !== "tool" && part.text.length <= MAX_TEXT) {
            existing.snapshot = prior && prior.type !== "tool" && prior.text.startsWith(part.text) ? prior : part
          }
          if (part.type === "tool" && !existing.changed && json(part)) existing.part = part
          continue
        }
        if (partCount >= MAX_PARTS) continue
        // Oversized snapshot values remain authoritative history, not live buffers.
        if (
          (part.type !== "tool" && part.text.length > MAX_TEXT) ||
          (part.type === "tool" &&
            (!json(part) || (part.state.status === "pending" && part.state.input.length > MAX_TEXT)))
        )
          continue
        overlay.parts.set(key(part), { part, ended: false })
        partCount++
      }
    }
    return messages()
  }

  function apply(event: LiveEvent): boolean {
    if (!record(event) || !id(event.id) || !string(event.type) || seen.has(event.id) || !record(event.data))
      return false
    const d = event.data
    if (d.sessionID !== session.id || !id(d.assistantMessageID) || !finite(d.timestamp) || !json(d)) return false
    const type = event.type
    const current = active.get(d.assistantMessageID)
    const stored = base.find(
      (message): message is Assistant => message.id === d.assistantMessageID && message.type === "assistant",
    )
    let info = current?.info ?? stored
    let settled = current?.settled === true || stored?.time.completed !== undefined
    let next: Part | undefined
    let ended = false
    let partKey: string | undefined

    if (type === "session.next.step.started") {
      if (
        !string(d.agent) ||
        !record(d.model) ||
        !id(d.model.id) ||
        !id(d.model.providerID) ||
        (d.model.variant !== undefined && !string(d.model.variant))
      )
        return false
      if (info) return false
      info = {
        id: d.assistantMessageID,
        type: "assistant",
        agent: d.agent,
        model: {
          id: d.model.id,
          providerID: d.model.providerID,
          ...(d.model.variant === undefined ? {} : { variant: d.model.variant }),
        },
        content: [],
        time: { created: d.timestamp },
      }
    } else if (type === "session.next.step.ended" || type === "session.next.step.failed") {
      if (!info || settled) return false
      if (type === "session.next.step.failed") {
        if (!record(d.error) || d.error.type !== "unknown" || !string(d.error.message)) return false
        info = {
          ...info,
          finish: "error",
          error: { type: "unknown", message: d.error.message },
          time: { ...info.time, completed: d.timestamp },
        }
      } else {
        if (
          !string(d.finish) ||
          !finite(d.cost) ||
          !record(d.tokens) ||
          !finite(d.tokens.input) ||
          !finite(d.tokens.output) ||
          !finite(d.tokens.reasoning) ||
          !record(d.tokens.cache) ||
          !finite(d.tokens.cache.read) ||
          !finite(d.tokens.cache.write)
        )
          return false
        info = {
          ...info,
          finish: d.finish,
          cost: d.cost,
          tokens: {
            input: d.tokens.input,
            output: d.tokens.output,
            reasoning: d.tokens.reasoning,
            cache: { read: d.tokens.cache.read, write: d.tokens.cache.write },
          },
          time: { ...info.time, completed: d.timestamp },
        }
      }
      settled = true
    } else {
      if (!info) return false
      const match =
        /^session\.next\.(text|reasoning|tool)(?:\.(input))?\.(started|delta|ended|called|progress|success|failed)$/.exec(
          type,
        )
      if (!match) return false
      const kind = match[1] as Part["type"]
      const input = match[2] === "input"
      const action = match[3]
      if (
        (kind !== "tool" && input) ||
        (kind !== "tool" && !["started", "delta", "ended"].includes(action!)) ||
        (kind === "tool" && input !== ["started", "delta", "ended"].includes(action!))
      )
        return false
      const partID = d[kind === "text" ? "textID" : kind === "reasoning" ? "reasoningID" : "callID"]
      if (!id(partID)) return false
      partKey = `${kind}:${partID}`
      const existing = current?.parts.get(partKey)
      const previous = existing?.part ?? stored?.content.find((part) => key(part) === partKey)
      if (existing?.ended && action !== "ended") return false
      if (action === "started") {
        if (previous || settled) return false
        if (kind === "tool") {
          if (!string(d.name)) return false
          next = {
            type: "tool",
            id: partID,
            name: d.name,
            time: { created: d.timestamp },
            state: { status: "pending", input: "" },
          }
        } else
          next =
            kind === "text"
              ? { type: kind, id: partID, text: "" }
              : { type: kind, id: partID, text: "", time: { created: d.timestamp } }
      } else if (action === "delta" || action === "ended") {
        const value = action === "delta" ? d.delta : d.text
        if (!string(value) || (action === "delta" && (!previous || settled))) return false
        // Never pin a truncated completion over a later full snapshot.
        if (action === "ended" && kind !== "tool" && value.length > MAX_TEXT) return false
        if (kind === "tool") {
          if (previous?.type !== "tool" || previous.state.status !== "pending") return false
          next = {
            ...previous,
            state: {
              status: "pending",
              input: (action === "ended" ? value : previous.state.input + value).slice(0, MAX_TEXT),
            },
          }
        } else {
          if (previous?.type === "tool") return false
          const text = (action === "ended" ? value : (previous?.text ?? "") + value).slice(0, MAX_TEXT)
          next =
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
                }
        }
        ended = action === "ended" && kind !== "tool"
      } else {
        if (previous?.type !== "tool") return false
        const state = previous.state
        if (state.status === "completed" || state.status === "error") return false
        if (action !== "progress" && (!record(d.provider) || typeof d.provider.executed !== "boolean")) return false
        if (action === "called") {
          if (state.status !== "pending" || !string(d.tool) || !record(d.input) || !json(d.input)) return false
          next = {
            ...previous,
            name: d.tool,
            provider: { executed: (d.provider as { executed: boolean }).executed },
            time: { ...previous.time, ran: d.timestamp },
            state: { status: "running", input: d.input, structured: {}, content: [] },
          }
        } else if (action === "progress" || action === "success") {
          if (state.status !== "running" || !record(d.structured) || !json(d.structured) || !content(d.content))
            return false
          next = {
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
                  provider: {
                    executed: (d.provider as { executed: boolean }).executed || previous.provider?.executed === true,
                  },
                }
              : {}),
          }
          ended = action === "success"
        } else if (action === "failed") {
          if (!record(d.error) || d.error.type !== "unknown" || !string(d.error.message)) return false
          next = {
            ...previous,
            time: { ...previous.time, completed: d.timestamp },
            provider: {
              executed: (d.provider as { executed: boolean }).executed || previous.provider?.executed === true,
            },
            state: {
              status: "error",
              input: state.status === "pending" ? {} : state.input,
              structured: state.status === "pending" ? {} : state.structured,
              content: state.status === "pending" ? [] : state.content,
              error: { type: "unknown", message: d.error.message },
            },
          }
          ended = true
        } else return false
      }
    }
    if (next && partKey && !current?.parts.has(partKey) && partCount >= MAX_PARTS) return false
    if (!current) room()
    const overlay = current ?? { info: { ...info!, content: [] }, settled, parts: new Map() }
    overlay.info = { ...info!, content: [] }
    overlay.settled = settled
    if (next && partKey) {
      if (!overlay.parts.has(partKey)) partCount++
      overlay.parts.set(partKey, { part: next, ended, snapshot: overlay.parts.get(partKey)?.snapshot, changed: true })
    }
    active.set(d.assistantMessageID, overlay)
    seen.add(event.id)
    if (seen.size > MAX_EVENTS) seen.delete(seen.values().next().value!)
    return true
  }

  return { apply, snapshot, messages }
}
