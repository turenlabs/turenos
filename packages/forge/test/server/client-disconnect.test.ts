import { describe, expect, test } from "bun:test"
import * as Http from "node:http"
import * as Net from "node:net"
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as ClientDisconnect from "../../src/server/shared/client-disconnect"

// This exercises the same transport Forge serves its API from: a raw
// `node:http` server handed to `NodeHttpServer.layer` (see
// `src/server/server.ts` -> `serverLayer`). The client is a raw `net.Socket`
// so the disconnect is a genuine TCP teardown, not a fetch abort.
//
// Background: Bun 1.3.14's `node:http` server shim stops reporting peer
// disconnects on a connection once the request body has been fully consumed.
// `nodeEventsFired` below is the built-in negative control -- those listeners
// are attached at request entry, *before* the body is read, and on Bun they
// still never fire. Only the native-handle poll inside `ClientDisconnect`
// observes the hangup. See the comment block in
// `src/server/shared/client-disconnect.ts` for the full reproduction.

const isBun = typeof process.versions.bun === "string"

type Probe = {
  readonly bodyLength: number
  /** Did plain Node `aborted`/socket `close` fire? (attached pre-body-read) */
  readonly nodeEventsFired: boolean
  /** Did `ClientDisconnect` report the hangup? */
  readonly disconnectObserved: boolean
}

const waitForAbort = (signal: AbortSignal, millis: number) =>
  Effect.callback<boolean>((resume) => {
    if (signal.aborted) return resume(Effect.succeed(true))
    const onAbort = () => {
      clearTimeout(timer)
      resume(Effect.succeed(true))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resume(Effect.succeed(false))
    }, millis)
    signal.addEventListener("abort", onAbort, { once: true })
  })

type ProbeOptions = {
  readonly onProbe: (probe: Probe) => void
  /** Called once the request body has been fully consumed. */
  readonly onBodyConsumed: () => void
  readonly waitMillis: number
}

const handle = (request: HttpServerRequest.HttpServerRequest, options: ProbeOptions) =>
  Effect.gen(function* () {
    const source = NodeHttpServerRequest.toIncomingMessage(request)
    let nodeEventsFired = false
    const record = () => {
      nodeEventsFired = true
    }
    // The "just register the watcher earlier" hypothesis, attached before
    // anything touches the body. Kept as the negative control.
    source.once("aborted", record)
    source.socket.once("close", record)

    // Consuming the body is what disables Bun's disconnect detection.
    const body = yield* request.text
    options.onBodyConsumed()

    const disconnectObserved = yield* ClientDisconnect.use(request, (signal) =>
      waitForAbort(signal, options.waitMillis),
    )
    options.onProbe({ bodyLength: body.length, nodeEventsFired, disconnectObserved })
    return HttpServerResponse.text("done")
  })

const probeServer = (options: ProbeOptions) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }))
    const server = Context.get(context, HttpServer.HttpServer)
    yield* server.serve(HttpServerRequest.HttpServerRequest.use((request) => handle(request, options)))
    if (server.address._tag !== "TcpAddress") throw new Error(`unexpected address: ${server.address._tag}`)
    return server.address.port
  })

/**
 * Sends a body-carrying POST from a raw socket, waits until the server has
 * drained the body, then either kills the connection or leaves it open.
 */
async function post(port: number, options: { readonly disconnect: boolean; readonly bodyConsumed: Promise<void> }) {
  const socket = Net.connect(port, "127.0.0.1")
  socket.on("error", () => {})
  socket.on("data", () => {})
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
  const body = JSON.stringify({ probe: "client-disconnect" })
  socket.write(
    `POST /probe HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
  await options.bodyConsumed
  if (options.disconnect) socket.destroy()
  return socket
}

function deferred<A>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((r) => (resolve = r))
  return { promise, resolve }
}

const run = (disconnect: boolean, waitMillis: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const probe = deferred<Probe>()
      const bodyConsumed = deferred<void>()
      const port = yield* probeServer({
        waitMillis,
        onProbe: probe.resolve,
        onBodyConsumed: () => bodyConsumed.resolve(),
      })
      const socket = yield* Effect.promise(() => post(port, { disconnect, bodyConsumed: bodyConsumed.promise }))
      const result = yield* Effect.promise(() => probe.promise)
      socket.destroy()
      return result
    }).pipe(Effect.scoped),
  )

describe("client disconnect", () => {
  test("is observed after a body-carrying POST is torn down mid-flight", async () => {
    const probe = await run(true, 5_000)

    expect(probe.bodyLength).toBeGreaterThan(0)
    expect(probe.disconnectObserved).toBe(true)

    // On Bun the stock Node events are silent even though they were attached
    // before the body was read -- this is what the fix works around.
    //
    // THIS ASSERTION IS DELIBERATELY BACKWARDS: it passes while Bun is BROKEN.
    // If it ever fails here, that is good news, not a regression -- Bun started
    // reporting the disconnect on its own. Follow the "CAN I DELETE THIS YET?"
    // block in `src/server/shared/client-disconnect.ts` to rip out the
    // native-handle poll, then delete this assertion.
    if (isBun) expect(probe.nodeEventsFired).toBe(false)
  }, 20_000)

  test("is not reported while the client is still connected", async () => {
    const probe = await run(false, 750)

    expect(probe.bodyLength).toBeGreaterThan(0)
    expect(probe.disconnectObserved).toBe(false)
  }, 20_000)
})
