import { eventStream } from "./live-events/stream"
import { identifier, invalid, isRecord, name, parseResponse } from "./response-validation"

export type LiveEvent = {
  id: string
  type: string
  data: Record<string, unknown>
  durable?: { aggregateID: string; seq: number; version: number }
}

function envelope(text: string): LiveEvent {
  const value = parseResponse(text)
  if (!isRecord(value) || !isRecord(value.data)) invalid("live event")
  const event: LiveEvent = { id: identifier(value.id), type: name(value.type), data: value.data }
  if (value.durable !== undefined) {
    const durable = value.durable
    if (!isRecord(durable)) invalid("live event durable metadata")
    const { seq, version } = durable
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) invalid("live event sequence")
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) invalid("live event version")
    event.durable = { aggregateID: identifier(durable.aggregateID), seq, version }
  }
  return event
}

export async function* liveEvents(baseURL: URL, headers: Headers, signal: AbortSignal): AsyncIterable<LiveEvent> {
  for await (const data of eventStream(baseURL, "/api/event", headers, signal)) yield envelope(data)
}

export { eventStream }
