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

/** The data of each server-sent event on `path`, such as `/global/event`, unparsed. */
export async function* eventStream(
  baseURL: URL,
  path: string,
  headers: Headers,
  signal: AbortSignal,
): AsyncIterable<string> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    controller.abort()
    const current = reader
    reader = undefined
    if (current)
      void current
        .cancel()
        .catch(() => {})
        .finally(() => current.releaseLock())
  }
  const abort = () => stop()
  const deadline = (milliseconds: number) => {
    clearTimeout(timer)
    timer = setTimeout(stop, milliseconds)
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    if (signal.aborted) stop()
    controller.signal.throwIfAborted()
    const requestHeaders = new Headers(headers)
    requestHeaders.set("Accept", "text/event-stream")
    deadline(10000)
    const response = await fetch(new URL(path, baseURL), {
      headers: requestHeaders,
      signal: controller.signal,
      redirect: "error",
    })
    reader = response.body?.getReader()
    controller.signal.throwIfAborted()
    if (!response.ok) throw new Error(`Live events request failed (HTTP ${response.status}).`)
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
      invalid("live event content type")
    if (!reader) invalid("live event stream")
    deadline(45000)

    // Count wire bytes per frame, not per connection. Keep partial UTF-8 bytes until a complete line arrives.
    const line = new Uint8Array(1024 * 1024)
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let length = 0
    let frameBytes = 0
    let carriageReturn = false
    let data: string[] = []
    while (reader) {
      const chunk = await reader.read()
      controller.signal.throwIfAborted()
      if (chunk.done) return
      deadline(45000)
      for (const byte of chunk.value) {
        controller.signal.throwIfAborted()
        if (carriageReturn && byte === 10) {
          carriageReturn = false
          if (frameBytes && ++frameBytes > line.length) invalid("live event frame exceeds 1 MiB")
          continue
        }
        carriageReturn = byte === 13
        if (++frameBytes > line.length) invalid("live event frame exceeds 1 MiB")
        if (byte !== 10 && byte !== 13) {
          line[length++] = byte
          continue
        }
        const text = decoder.decode(line.subarray(0, length))
        length = 0
        if (text === "") {
          frameBytes = 0
          const payload = data
          data = []
          if (payload.length) yield payload.join("\n")
        } else if (text === "data" || text.startsWith("data:")) {
          const value = text.slice(5)
          data.push(value.startsWith(" ") ? value.slice(1) : value)
        }
      }
    }
    controller.signal.throwIfAborted()
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal.aborted ? "Live events aborted." : "Live events timed out.")
    // Fetch errors can contain URLs; never expose the original request or credentials.
    if (error instanceof Error && /^(Invalid server response|Live events request failed)/.test(error.message))
      throw error
    throw new Error("Live events connection failed.")
  } finally {
    stop()
  }
}
