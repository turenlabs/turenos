/** The most a server may send in one response, enforced before anything parses it. */
export const RESPONSE_BYTES = 8 * 1024 * 1024
export const RESPONSE_CHUNKS = 8192

type Limits = {
  bytes?: number
  chunks?: number
  /** Names the peer in the limit error: "Server" (default) or "Provider". */
  label?: string
  /** Replaces a read failure, for callers that must not expose the transport's own error text. */
  failed?: () => Error
}

/**
 * Collects a body's chunks up to the byte and chunk limits and cancels the stream as soon as either
 * is passed, so an oversized response is refused without being buffered first.
 */
export async function readBounded(stream: ReadableStream<Uint8Array>, limits: Limits = {}) {
  const bytes = limits.bytes ?? RESPONSE_BYTES
  const chunks = limits.chunks ?? RESPONSE_CHUNKS
  const label = limits.label ?? "Server"
  const reader = stream.getReader()
  const collected: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read().catch((error: unknown) => {
        throw limits.failed ? limits.failed() : error
      })
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > bytes) throw new Error(`${label} response exceeds the ${describeBytes(bytes)} TUI limit.`)
      if (collected.length >= chunks)
        throw new Error(`${label} response exceeds the ${chunks.toLocaleString("en-US")} chunk TUI limit.`)
      collected.push(new Uint8Array(chunk.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return collected
}

/** The body as text, or undefined when it is missing, exceeds `bytes`, or cannot be read. */
export async function boundedText(response: Response, bytes: number) {
  if (!response.body) return undefined
  return readBounded(response.body, { bytes }).then(
    (chunks) => new Blob(chunks).text(),
    () => undefined,
  )
}

function describeBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`
}
