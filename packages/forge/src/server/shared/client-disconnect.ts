import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import type * as Http from "node:http"

/**
 * A trustworthy "the client hung up" signal for TurenOS's HTTP server.
 *
 * ## Why this file exists
 *
 * TurenOS serves its API from a raw `node:http` server (`Server.listen` ->
 * `createServer()` -> `NodeHttpServer.layer`, see `src/server/server.ts`).
 * Under Bun that means Bun's `node:http` *server* shim, which has a defect:
 *
 * > Bun 1.3.14 stops watching a connection for peer disconnects once the
 * > request body has been fully consumed.
 *
 * Reproduction (verified on bun 1.3.14, macOS): create an `http.createServer()`,
 * have the handler drain `req` to EOF, then hold the response open. Connect a
 * raw `net.Socket`, send `POST / HTTP/1.1` with a `Content-Length` body, and
 * `destroy()` the client. The server observes *nothing*: no `req` `"aborted"`,
 * no `res` `"close"`, no socket `"close"`/`"error"`/`"timeout"` -- not even on
 * a listener attached at `server.on("connection")` before the request was
 * routed, so this cannot be fixed by registering earlier. Polling
 * `socket.destroyed` / `socket.writable` / `readyState` shows nothing, and
 * writing to the response never errors (30 x 2KB writes over 3s all "succeed").
 * The identical teardown on a `GET`, or on a `POST` whose body is left
 * unread, fires `aborted`/`close` in the same millisecond. Bun's fake socket
 * is not a `net.Socket` and its Node-facing `_handle` is `undefined`, so there
 * is no fd to watch through any documented API.
 *
 * This matters beyond TurenOS's own code: `@effect/platform-node`'s
 * `NodeHttpServer` implements client-abort as
 * `nodeResponse.on("close", ...) -> fiber.interruptUnsafe(ClientAbort)`. On Bun
 * that interrupt therefore never arrives for any body-carrying request, which
 * is nearly every mutating TurenOS API call.
 *
 * ## The fix
 *
 * Bun's *native* layer does still see the disconnect -- only the JS-side event
 * propagation is broken. The fake socket carries the native handle at
 * `socket[Symbol("handle")]`, and that handle's `closed` getter flips to `true`
 * within ~10ms of the peer going away (measured: client destroyed at 500ms,
 * `handle.closed === true` at 512ms), for both RST (`destroy()`) and clean FIN
 * (`end()`) teardown. So we keep the standard Node events (correct on real
 * Node, and on Bun for the bodyless requests it still reports) and, when the
 * native handle is reachable, additionally poll it.
 *
 * Polling only runs while a caller actually holds the signal (see `use`), so
 * this costs nothing on the requests that never ask.
 *
 * Remove the native-handle polling once Bun fixes the underlying bug; the
 * regression test in `test/server/client-disconnect.test.ts` will start failing
 * its negative control when that happens.
 */

/** How often to re-read Bun's native handle while a caller holds the signal. */
const POLL_INTERVAL_MILLIS = 100

/* ==========================================================================
 * HACK: undocumented Bun internal. Everything from here to `isClosed` below
 * exists ONLY to work around the Bun bug described at the top of this file.
 *
 * We reach into Bun's fake socket for its native handle, because that handle
 * knows the peer is gone even though no JS-visible event ever fires. There is
 * no supported API for this. It is matched by symbol *description* (the symbol
 * itself is not exported), every access is wrapped, and any failure degrades to
 * the plain Node events -- i.e. to the behavior we would have without this file.
 *
 * ---------------------------------------------------------------------------
 * CAN I DELETE THIS YET?  Run, from `packages/forge`:
 *
 *     bun test test/server/client-disconnect.test.ts
 *
 * That test asserts `nodeEventsFired === false` -- i.e. that Bun is still
 * broken. So:
 *
 *   - test PASSES  -> Bun is still broken, this hack is still load-bearing.
 *   - test FAILS on `nodeEventsFired` -> Bun fixed it. Delete `NATIVE_HANDLE_SYMBOL`,
 *     `nativeHandle`, `isClosed`, the polling block in `watch`, and that
 *     assertion. The plain Node listeners in `watch` are then sufficient and
 *     the rest of this module keeps working unchanged.
 *
 * Last confirmed broken: bun 1.3.14 (macOS arm64).
 * Upstream: not yet reported to Bun as of this writing.
 * ========================================================================== */
const NATIVE_HANDLE_SYMBOL = "Symbol(handle)"

type NativeHandle = { readonly closed?: unknown }

function nativeHandle(socket: unknown): NativeHandle | undefined {
  if (typeof socket !== "object" || socket === null) return undefined
  try {
    const symbol = Object.getOwnPropertySymbols(socket).find((candidate) => String(candidate) === NATIVE_HANDLE_SYMBOL)
    if (!symbol) return undefined
    const handle: unknown = Reflect.get(socket, symbol)
    if (typeof handle !== "object" || handle === null) return undefined
    // `closed` lives on the handle's prototype, so `in` rather than `hasOwnProperty`.
    return "closed" in handle ? (handle as NativeHandle) : undefined
  } catch {
    // Undocumented internal: never let probing it fail a request.
    return undefined
  }
}

/** Reads the native `closed` flag, treating any failure as "still connected". */
function isClosed(handle: NativeHandle): boolean {
  try {
    return handle.closed === true
  } catch {
    return false
  }
}

/* ===================== end of the Bun workaround ========================== */

function isIncomingMessage(source: unknown): source is Http.IncomingMessage {
  if (typeof source !== "object" || source === null) return false
  const candidate = source as Partial<Http.IncomingMessage>
  return typeof candidate.on === "function" && typeof candidate.socket === "object"
}

export type Watcher = {
  /** Aborts when the client goes away. Never aborts on a normal response. */
  readonly signal: AbortSignal
  /** Detaches listeners and stops polling. Safe to call more than once. */
  readonly dispose: () => void
}

/**
 * Starts watching `request` for a client disconnect.
 *
 * Callers must `dispose()` when they stop caring, otherwise the poll timer
 * lives until the connection closes. Prefer `use`, which does that for you.
 */
export function watch(request: HttpServerRequest.HttpServerRequest): Watcher {
  const controller = new AbortController()

  // The `Server.Default()` web-handler path (tests, plugins, `forge run`) hands
  // us a real `Request`, whose `signal` already works. Nothing to fix there.
  const source: unknown = request.source
  if (source instanceof Request) return { signal: source.signal, dispose: () => {} }

  if (!isIncomingMessage(source)) return { signal: controller.signal, dispose: () => {} }

  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    source.removeListener("aborted", abort)
    source.socket?.removeListener("close", abort)
  }

  function abort() {
    if (controller.signal.aborted) return
    dispose()
    controller.abort()
  }

  // Correct on real Node, and on Bun for the requests it still reports
  // (GET, and any body it was never asked to read).
  source.once("aborted", abort)
  source.socket?.once("close", abort)

  // HACK (Bun): the listeners above are all a correct runtime needs. On Bun they
  // never fire for a body-carrying request, so we additionally poll the socket's
  // native handle. See the "CAN I DELETE THIS YET?" block above before touching
  // this -- it is dead weight the moment Bun fixes the bug.
  const handle = nativeHandle(source.socket)
  if (handle) {
    if (isClosed(handle)) {
      // Peer was already gone before anyone asked.
      abort()
    } else {
      timer = setInterval(() => {
        if (isClosed(handle)) abort()
      }, POLL_INTERVAL_MILLIS)
      // Never let the watcher hold the process open.
      timer.unref?.()
    }
  }

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
