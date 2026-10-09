import { eventStream } from "./live-events/stream"
import { identifier, invalid, isRecord, name, parseResponse } from "./response-validation"

export type LiveEvent = {
  id: string
  type: string
  data: Record<string, unknown>
  durable?: { aggregateID: string; seq: number; version: number }
}

/** The event in one frame, or undefined for a frame that is not a valid event: such a frame is skipped. */
function envelope(text: string): LiveEvent | undefined {
  try {
    const value = parseResponse(text)
    if (!isRecord(value) || !isRecord(value.data)) invalid("live event")
    const event: LiveEvent = { id: identifier(value.id), type: name(value.type), data: value.data }
    if (value.durable !== undefined) event.durable = durable(value.durable)
    return event
  } catch {
    return
  }
}

function durable(value: unknown) {
  if (!isRecord(value)) invalid("live event durable metadata")
  if (typeof value.aggregateID !== "string" || value.aggregateID.length > 256) invalid("live event aggregate")
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) invalid("live event sequence")
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0)
    invalid("live event version")
  return { aggregateID: value.aggregateID, seq: value.seq, version: value.version }
}

export async function* liveEvents(
  baseURL: URL,
  headers: Headers,
  signal: AbortSignal,
  socketPath?: string,
): AsyncIterable<LiveEvent> {
  for await (const data of eventStream(baseURL, headers, signal, socketPath)) {
    const event = envelope(data)
    if (event) yield event
  }
}
