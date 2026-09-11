import type { SessionReplayEvent } from "@turenlabs/sdk/v2/client"

export function replayEventSequence(event: SessionReplayEvent) {
  return event.durable.seq
}

export function replayEventTimestamp(event: SessionReplayEvent) {
  const data = event.data as Record<string, unknown>
  const info = record(data.info)
  const infoTime = record(info?.time)
  const part = record(data.part)
  const partTime = record(part?.time)
  for (const value of [data.timestamp, data.time, infoTime?.updated, infoTime?.created, partTime?.created]) {
    if (typeof value === "number") return value
    if (typeof value !== "string") continue
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

export function replayEventLabel(event: SessionReplayEvent) {
  return event.type.replace(/^session\.next\./, "").replaceAll(".", " / ")
}

export function replayEventPreview(event: SessionReplayEvent) {
  const data = event.data as Record<string, unknown>
  const error = data.error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  if (typeof data.exitCode === "number" && data.exitCode !== 0) return `exit ${data.exitCode}`
  for (const key of ["text", "command", "tool", "name", "status", "objective", "reason"] as const) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return compact(value)
  }
  const input = data.input
  if (input !== undefined) return compact(JSON.stringify(input))
  return replayEventLabel(event)
}

export function replayEventTone(event: SessionReplayEvent) {
  const data = event.data as Record<string, unknown>
  if (
    event.type.includes("failed") ||
    "error" in data ||
    data.status === "failed" ||
    data.status === "timed_out" ||
    (typeof data.exitCode === "number" && data.exitCode !== 0)
  )
    return "danger" as const
  if (event.type.includes("tool")) return "tool" as const
  if (event.type.includes("prompt") || event.type.includes("text")) return "message" as const
  if (event.type.includes("step")) return "step" as const
  return "neutral" as const
}

export function mergeReplayEvents(current: readonly SessionReplayEvent[], incoming: readonly SessionReplayEvent[]) {
  const seen = new Set(current.map((event) => event.id))
  return [...current, ...incoming.filter((event) => !seen.has(event.id))]
}

export function replayStats(events: readonly SessionReplayEvent[], cursor: number) {
  return events.slice(0, cursor + 1).reduce(
    (result, event) => ({
      events: result.events + 1,
      turns: result.turns + (event.type === "session.next.step.ended" ? 1 : 0),
      tools: result.tools + (event.type === "session.next.tool.called" ? 1 : 0),
      failures: result.failures + (replayEventTone(event) === "danger" ? 1 : 0),
    }),
    { events: 0, turns: 0, tools: 0, failures: 0 },
  )
}

export function replayMatchPreview(input: string) {
  return compact(input.replace(/[{}\[\]"]/g, " ").replace(/\s+/g, " "))
}

export function replayLaneLabel(aggregateID: string) {
  if (aggregateID.startsWith("ses_")) return "root"
  const prefix = aggregateID.split("_")[0] || "stream"
  return `${prefix}\u00b7${aggregateID.slice(-4)}`
}

export function replayLaneIndexes(events: readonly SessionReplayEvent[]) {
  const lanes = new Map<string, number>()
  for (const event of events) {
    if (!lanes.has(event.durable.aggregateID)) lanes.set(event.durable.aggregateID, lanes.size)
  }
  return lanes
}

const SPAN_STARTS: Record<string, { key: string; ends: readonly string[] }> = {
  "session.next.step.started": {
    key: "assistantMessageID",
    ends: ["session.next.step.ended", "session.next.step.failed"],
  },
  "session.next.tool.called": {
    key: "callID",
    ends: ["session.next.tool.success", "session.next.tool.failed"],
  },
  "session.next.shell.started": { key: "callID", ends: ["session.next.shell.ended"] },
}

const SPAN_ENDS = new Map(
  Object.entries(SPAN_STARTS).flatMap(([start, span]) =>
    span.ends.map((end) => [end, { start, key: span.key }] as const),
  ),
)

/** Milliseconds between a span's start event and its settlement, keyed by settlement event ID. */
export function replayDurations(events: readonly SessionReplayEvent[]) {
  const open = new Map<string, number>()
  const durations = new Map<string, number>()
  for (const event of events) {
    const data = event.data as Record<string, unknown>
    const start = SPAN_STARTS[event.type]
    if (start) {
      const key = data[start.key]
      if (typeof key === "string") open.set(`${event.type}:${key}`, replayEventTimestamp(event))
      continue
    }
    const end = SPAN_ENDS.get(event.type)
    if (!end) continue
    const key = data[end.key]
    if (typeof key !== "string") continue
    const started = open.get(`${end.start}:${key}`)
    const finished = replayEventTimestamp(event)
    if (started === undefined || finished === 0 || finished < started) continue
    durations.set(event.id, finished - started)
  }
  return durations
}

export function replayDelta(from: number, to: number) {
  if (!from || !to || to < from) return ""
  return `+${replayDuration(to - from)}`
}

export function replayDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
}

export interface ReplayRow {
  label: string
  value: string
  mono?: boolean
  danger?: boolean
}

export interface ReplayBlock {
  title: string
  text: string
  mono?: boolean
  danger?: boolean
}

const BLOCK_KEYS = new Set(["text", "command", "output", "reason", "objective", "title"])
const SKIP_KEYS = new Set(["time"])
const ROW_ORDER = [
  "tool",
  "agent",
  "model.providerID",
  "model.modelID",
  "status",
  "finish",
  "callID",
  "messageID",
  "assistantMessageID",
  "sessionID",
]

/** Structured payload for the inspector: scalar rows plus long-form blocks. Raw JSON stays the fallback. */
export function replayPayload(event: SessionReplayEvent) {
  const rows: ReplayRow[] = []
  const blocks: ReplayBlock[] = []
  const push = (key: string, value: unknown) => {
    if (value === undefined || value === null || SKIP_KEYS.has(key)) return
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value)
      if (BLOCK_KEYS.has(key) || text.length > 140) {
        blocks.push({ title: key, text, mono: key !== "reason" && key !== "objective" })
        return
      }
      rows.push({ label: key, value: text, mono: /(^|[._])(id|path|directory|snapshot)$/i.test(key) })
      return
    }
    if (Array.isArray(value)) {
      if (key === "content") {
        const text = value
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
          .filter(Boolean)
          .join("\n")
        if (text) blocks.push({ title: "content", text })
        return
      }
      if (value.every((item) => typeof item === "string")) {
        for (const item of value) rows.push({ label: key, value: item, mono: true })
        return
      }
      blocks.push({ title: key, text: JSON.stringify(value, null, 2), mono: true })
      return
    }
    if (typeof value === "object") {
      const rec = record(value)
      if (!rec) return
      if (key === "error") {
        blocks.push({
          title: "error",
          text: typeof rec.message === "string" ? rec.message : JSON.stringify(rec, null, 2),
          danger: true,
          mono: true,
        })
        return
      }
      const scalars = Object.entries(rec).filter((entry) =>
        ["string", "number", "boolean"].includes(typeof entry[1]),
      )
      if (scalars.length === 0) {
        blocks.push({ title: key, text: JSON.stringify(value, null, 2), mono: true })
        return
      }
      for (const [sub, item] of scalars.slice(0, 8)) {
        push(`${key}.${sub}`, item)
      }
      return
    }
  }
  for (const [key, value] of Object.entries(event.data as Record<string, unknown>)) push(key, value)
  const rank = (row: ReplayRow) => {
    const index = ROW_ORDER.indexOf(row.label)
    return index === -1 ? ROW_ORDER.length : index
  }
  rows.sort((a, b) => rank(a) - rank(b))
  return { rows: rows.slice(0, 16), blocks: blocks.slice(0, 6) }
}

function compact(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > 180 ? `${value.slice(0, 177)}...` : value
}

function record(input: unknown) {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}
