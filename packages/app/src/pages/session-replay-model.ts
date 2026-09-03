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
  for (const key of ["text", "command", "tool", "name", "status", "objective", "reason"] as const) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return compact(value)
  }
  const input = data.input
  if (input !== undefined) return compact(JSON.stringify(input))
  return replayEventLabel(event)
}

export function replayEventTone(event: SessionReplayEvent) {
  if (event.type.includes("failed") || "error" in event.data) return "danger" as const
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

function compact(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > 180 ? `${value.slice(0, 177)}...` : value
}

function record(input: unknown) {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}
