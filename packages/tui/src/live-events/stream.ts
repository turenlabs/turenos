import { invalid } from "../response-validation"
import { newFrames, pushByte } from "./frames"

/** The data of each server-sent event on `path`, such as `/global/event`, unparsed. */
export async function* eventStream(
  baseURL: URL,
  path: string,
  headers: Headers,
  signal: AbortSignal,
): AsyncIterable<string> {
  const guard = createGuard(signal)
  const controller = guard.controller
  try {
    if (signal.aborted) guard.stop()
    controller.signal.throwIfAborted()
    const requestHeaders = new Headers(headers)
    requestHeaders.set("Accept", "text/event-stream")
    guard.deadline(10000)
    const response = await fetch(new URL(path, baseURL), {
      headers: requestHeaders,
      signal: controller.signal,
      redirect: "error",
    })
    guard.reader = response.body?.getReader()
    controller.signal.throwIfAborted()
    if (!response.ok) throw new Error(`Live events request failed (HTTP ${response.status}).`)
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
      invalid("live event content type")
    if (!guard.reader) invalid("live event stream")
    guard.deadline(45000)

    const frames = newFrames()
    while (guard.reader) {
      const chunk = await guard.reader.read()
      controller.signal.throwIfAborted()
      if (chunk.done) return
      guard.deadline(45000)
      for (const byte of chunk.value) {
        controller.signal.throwIfAborted()
        const payload = pushByte(frames, byte)
        if (payload !== undefined) yield payload
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
    guard.stop()
  }
}

/** Owns the request's abort controller, idle deadline and body reader so every exit releases all three. */
function createGuard(signal: AbortSignal) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = {
    controller,
    reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined,
    stop() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.abort()
      const current = guard.reader
      guard.reader = undefined
      if (current)
        void current
          .cancel()
          .catch(() => {})
          .finally(() => current.releaseLock())
    },
    deadline(milliseconds: number) {
      clearTimeout(timer)
      timer = setTimeout(guard.stop, milliseconds)
    },
  }
  const abort = () => guard.stop()
  signal.addEventListener("abort", abort, { once: true })
  return guard
}
