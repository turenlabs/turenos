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
// Bun 1.4.1 reports native disconnect events after body consumption. Keep this
// positive transport regression so a future runtime cannot silently strand work.

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
  readonly afterClose: boolean
}

// Keep the probe alive after the transport interrupts the request fiber so it can
// report the watcher result, including when watching starts after disconnection.
const handle = (request: HttpServerRequest.HttpServerRequest, options: ProbeOptions) =>
  Effect.gen(function* () {
    const source = NodeHttpServerRequest.toIncomingMessage(request)
    let nodeEventsFired = false
    const record = () => {
      nodeEventsFired = true
    }
    // Observe the runtime events independently of the watcher.
    source.once("aborted", record)
    source.socket.once("close", record)

    // Drain the body before teardown, matching admitted mutating API requests.
    const body = yield* request.text
    const closed = options.afterClose
      ? new Promise<void>((resolve) => source.socket.once("close", () => resolve()))
      : undefined
    options.onBodyConsumed()
    if (closed) yield* Effect.promise(() => closed)

    const disconnectObserved = yield* ClientDisconnect.use(request, (signal) =>
      waitForAbort(signal, options.waitMillis),
    )
    options.onProbe({ bodyLength: body.length, nodeEventsFired, disconnectObserved })
    return HttpServerResponse.text("done")
  }).pipe(Effect.uninterruptible)

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
async function post(
  port: number,
  options: { readonly disconnect: "destroy" | "end" | false; readonly bodyConsumed: Promise<void> },
) {
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
  if (options.disconnect === "destroy") socket.destroy()
  if (options.disconnect === "end") socket.end()
  return socket
}

function deferred<A>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((r) => (resolve = r))
  return { promise, resolve }
}

const run = (disconnect: "destroy" | "end" | false, waitMillis: number, afterClose = false) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const probe = deferred<Probe>()
      const bodyConsumed = deferred<void>()
      const port = yield* probeServer({
        waitMillis,
        afterClose,
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
  test.each(["destroy", "end"] as const)(
    "observes a consumed POST disconnected with %s",
    async (disconnect) => {
      const probe = await run(disconnect, 5_000)
      expect(probe.bodyLength).toBeGreaterThan(0)
      expect(probe.disconnectObserved).toBe(true)
      expect(probe.nodeEventsFired).toBe(true)
    },
    20_000,
  )

  test("observes a disconnect that happened before watching began", async () => {
    const probe = await run("destroy", 5_000, true)
    expect(probe.bodyLength).toBeGreaterThan(0)
    expect(probe.disconnectObserved).toBe(true)
    expect(probe.nodeEventsFired).toBe(true)
  }, 20_000)

  test("is not reported while the client is still connected", async () => {
    const probe = await run(false, 750)

    expect(probe.bodyLength).toBeGreaterThan(0)
    expect(probe.disconnectObserved).toBe(false)
  }, 20_000)
})
