import { afterEach, describe, expect, test } from "bun:test"
import { Context, Config as EffectConfig, Effect, Layer, Queue, Schema } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import path from "path"
import { pathToFileURL } from "url"
import { mkdir } from "fs/promises"
import { Location } from "@turenlabs/core/location"
import { Pty } from "@turenlabs/core/pty"
import { PtyTicket } from "@turenlabs/core/pty/ticket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testPty = process.platform === "win32" ? test.skip : test

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-forge-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, EffectConfig.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.createRoutes({ cors: ["https://pty.example"] }),
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-forge-directory", dir)

const serverUrl = () => HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 pty HttpApi", () => {
  testPty("serves location-wrapped PTY routes and retains exited sessions", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const empty = await request("/api/pty", tmp.path)
    expect(empty.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await empty.json()).data).toEqual([])

    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "exit 4"], title: "v2" }),
    })
    expect(created.status).toBe(200)
    const body = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json())
    expect(String(body.location.directory)).toBe(tmp.path)
    expect(body.data.title).toBe("v2")

    // The canonical surface keeps exited sessions observable with their exit code.
    const deadline = Date.now() + 15_000
    let info: { status: string; exitCode?: number } | undefined
    while (Date.now() < deadline) {
      const found = await request(`/api/pty/${body.data.id}`, tmp.path)
      expect(found.status).toBe(200)
      info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await found.json()).data
      if (info.status === "exited") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(info).toMatchObject({ status: "exited", exitCode: 4 })

    const removed = await request(`/api/pty/${body.data.id}`, tmp.path, { method: "DELETE" })
    expect(removed.status).toBe(204)

    const missing = await request(`/api/pty/${body.data.id}`, tmp.path)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "PtyNotFoundError", ptyID: body.data.id })
  })

  // Session, file and PTY routes must share one Location map. When the file and PTY handlers
  // provided their own, every directory the app opened got two full Location service graphs,
  // doubling their memory, watchers and threads.
  testPty("builds one set of Location services per directory across route groups", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using marker = await tmpdir({ config: { formatter: false, lsp: false } })
    const log = path.join(process.env["XDG_DATA_HOME"]!, "forge", "log", "forge.log")
    const lines = async () => (await Bun.file(log).text().catch(() => "")).split("\n")

    const session = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(session.status).toBe(200)
    const sessionID = ((await session.json()) as { data: { id: string } }).data.id
    expect((await request(`/api/session/${sessionID}/context`, tmp.path)).status).toBe(200)
    expect((await request("/file?path=.", tmp.path)).status).toBe(200)
    expect((await request("/api/pty", tmp.path)).status).toBe(200)

    // The file logger writes in batches. Opening another directory logs after every boot above,
    // so once its line is on disk, so is every boot line.
    expect((await request("/path", marker.path)).status).toBe(200)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !(await lines()).some((line) => line.includes("creating instance") && line.includes(marker.path)))
      await new Promise((resolve) => setTimeout(resolve, 50))
    const boots = (await lines()).filter((line) => line.includes("booting location services") && line.includes(tmp.path))
    expect(boots).toHaveLength(1)
  })

  testPty("rejects connect tokens without the CSRF header and connects with a valid ticket", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 5"] }),
    })
    expect(created.status).toBe(200)
    const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

    try {
      const forbidden = await request(`/api/pty/${info.id}/connect-token`, tmp.path, { method: "POST" })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({ _tag: "ForbiddenError" })

      const token = await request(`/api/pty/${info.id}/connect-token`, tmp.path, {
        method: "POST",
        headers: { "x-forge-ticket": "1" },
      })
      expect(token.status).toBe(200)
      const ticket = Schema.decodeUnknownSync(Location.response(PtyTicket.ConnectToken))(await token.json()).data.ticket
      expect(ticket).toBeTruthy()

      const invalid = await request(`/api/pty/${info.id}/connect?ticket=not-a-ticket`, tmp.path)
      expect(invalid.status).toBe(403)

      const ticketless = await request(`/api/pty/${info.id}/connect`, tmp.path)
      expect(ticketless.status).toBe(403)

      const crossOrigin = await request(`/api/pty/${info.id}/connect?ticket=${ticket}`, tmp.path, {
        headers: { origin: "https://evil.example" },
      })
      expect(crossOrigin.status).toBe(403)
    } finally {
      await request(`/api/pty/${info.id}`, tmp.path, { method: "DELETE" })
    }
  })
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "serves PTY websocket output and input through the canonical route",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const created = yield* HttpClientRequest.post("/api/pty").pipe(
          directoryHeader(dir),
          HttpClientRequest.bodyJson({ command: "/bin/cat", title: "v2-websocket" }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(created.status).toBe(200)
        const body = yield* Schema.decodeUnknownEffect(Location.response(Pty.Info))(yield* created.json)
        const info = body.data

        const token = yield* HttpClientRequest.post(`/api/pty/${info.id}/connect-token`).pipe(
          directoryHeader(dir),
          HttpClientRequest.setHeader("x-forge-ticket", "1"),
          HttpClient.execute,
        )
        expect(token.status).toBe(200)
        const ticket = yield* Schema.decodeUnknownEffect(Location.response(PtyTicket.ConnectToken))(yield* token.json)

        const socket = yield* Socket.makeWebSocket(
          `${(yield* serverUrl()).replace(/^http/, "ws")}/api/pty/${info.id}/connect?cursor=-1&location[directory]=${encodeURIComponent(dir)}&ticket=${ticket.data.ticket}`,
          { closeCodeIsError: () => false },
        )
        const messages = yield* Queue.unbounded<string>()
        yield* socket
          .runRaw((message) =>
            Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
          )
          .pipe(Effect.catch(() => Effect.void))
          .pipe(Effect.forkScoped)
        const write = yield* socket.writer

        const takeUntil = (expected: string, seen = ""): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            const next = seen + (yield* Queue.take(messages).pipe(Effect.timeout("5 seconds")))
            if (next.includes(expected)) return next
            return yield* takeUntil(expected, next)
          })

        yield* write("ping-v2\n")
        expect(yield* takeUntil("ping-v2")).toContain("ping-v2")
        yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))

        const nextToken = yield* HttpClientRequest.post(`/api/pty/${info.id}/connect-token`).pipe(
          directoryHeader(dir),
          HttpClientRequest.setHeader("x-forge-ticket", "1"),
          HttpClientRequest.setHeader("origin", "https://pty.example"),
          HttpClient.execute,
        )
        expect(nextToken.status).toBe(200)
        const nextTicket = yield* Schema.decodeUnknownEffect(Location.response(PtyTicket.ConnectToken))(
          yield* nextToken.json,
        )
        const removed = yield* HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(
          directoryHeader(dir),
          HttpClient.execute,
        )
        expect(removed.status).toBe(204)

        // The configured origin must reach both token issuance and pre-Location
        // validation. Only a valid ticket can observe that the PTY was removed.
        const connect = HttpClientRequest.get(`/api/pty/${info.id}/connect?ticket=${nextTicket.data.ticket}`).pipe(
          directoryHeader(dir),
          HttpClientRequest.setHeader("origin", "https://pty.example"),
        )
        expect((yield* HttpClient.execute(connect)).status).toBe(404)
        expect((yield* HttpClient.execute(connect)).status).toBe(403)
      }),
  )
})
