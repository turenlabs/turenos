import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type { IncomingMessage } from "node:http"

/** Client-disconnect signals for Node HTTP requests and native web Requests. */
function isIncomingMessage(source: unknown): source is IncomingMessage {
  if (typeof source !== "object" || source === null) return false
  const candidate = source as Partial<IncomingMessage>
  return typeof candidate.on === "function" && typeof candidate.socket === "object"
}

export type Watcher = {
  /** Aborts when the client goes away. Never aborts on a normal response. */
  readonly signal: AbortSignal
  /** Detaches listeners. Safe to call more than once. */
  readonly dispose: () => void
}

/**
 * Starts watching `request` for a client disconnect.
 *
 * Callers must `dispose()` when they stop caring. Prefer `use`, which does that for you.
 */
export function watch(request: HttpServerRequest.HttpServerRequest): Watcher {
  const controller = new AbortController()

  // The `Server.Default()` web-handler path (tests, plugins, `forge run`) hands
  // us a real `Request`, whose `signal` already works. Nothing to fix there.
  const source: unknown = request.source
  if (source instanceof Request) return { signal: source.signal, dispose: () => {} }

  if (!isIncomingMessage(source)) return { signal: controller.signal, dispose: () => {} }

  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    source.removeListener("aborted", abort)
    source.socket?.removeListener("close", abort)
  }

  function abort() {
    if (controller.signal.aborted) return
    dispose()
    controller.abort()
  }

  source.once("aborted", abort)
  source.socket?.once("close", abort)

  // The peer may have closed before the caller started watching, after body admission.
  // Request.destroyed also becomes true on normal body completion; only the socket
  // destruction and explicit request abortion mean the connection is gone.
  if (source.aborted || source.socket?.destroyed) abort()

  return { signal: controller.signal, dispose }
}

/**
 * Runs `f` with a client-disconnect signal, tearing the watcher down when `f`
 * settles (including on failure or interruption).
 */
export const use = <A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  f: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const watcher = watch(request)
    return f(watcher.signal).pipe(Effect.ensuring(Effect.sync(watcher.dispose)))
  })
