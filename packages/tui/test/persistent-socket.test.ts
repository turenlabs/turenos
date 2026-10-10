import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountDashboard } from "../src/dashboard/mount"
import { connect } from "../src/server"
import { createServers } from "../src/servers"
import { persistentAttach, PERSISTENT_SOCKET } from "../src/servers/records"
import { cleanup, terminal, turen } from "./support"

/** A scratch home with a 1.0.44 persistent server on a Unix socket and its version 2 attach record. */
async function persistent(record: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "tui-socket-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const socketPath = join(home, "server.sock")
  const live = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) =>
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_1", type: "server.connected", data: {} })}\n\n`)),
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  const server = turen({
    socket: socketPath,
    password: "secret",
    routes: {
      "GET /global/health": () => ({ healthy: true, version: "1.0.44" }),
      "GET /global/server": () => ({ serverID: "srv_1", mode: "persistent" }),
      "GET /api/event": live,
    },
  })
  const file = join(home, "attach.json")
  const published = { version: 2, serverID: "srv_1", socketPath, username: "forge", password: "secret", ...record }
  await writeFile(file, JSON.stringify(published))
  const servers = createServers({
    home,
    platform: "linux",
    uid: undefined,
    env: {},
    forge: null,
    config: join(home, "servers.json"),
    persistentRecord: file,
    persistentSocket: socketPath,
  })
  return { server, servers, socketPath }
}

test("a version 2 record reaches the persistent server through its socket, and the picker names the socket", async () => {
  const { server, servers, socketPath } = await persistent()
  const entry = (await servers.scan()).find((item) => item.target.kind === "persistent")!
  expect(entry.detail).toBe(`turenos.service · ${socketPath}`)
  const endpoint = await servers.resolve(entry.target)
  expect(endpoint).toMatchObject({ url: "http://localhost", socketPath, username: "forge", version: "1.0.44" })
  // The record's serverID was checked against the server's own answer, over the socket.
  expect(server.paths()).toEqual(expect.arrayContaining(["/global/health", "/global/server"]))
})

test("the dashboard and its live events run over the socket", async () => {
  const { server, servers } = await persistent()
  const endpoint = await servers.resolve((await servers.preferred())!)
  const { view, screen } = await terminal(100, 30)
  const connection = connect({
    url: endpoint.url,
    socketPath: endpoint.socketPath,
    username: endpoint.username,
    password: endpoint.password,
  })
  expect(connection.address).toBe(`unix:${endpoint.socketPath}`)
  const app = mountDashboard(view.renderer, connection, endpoint.url)
  cleanup.push(app.dispose)
  await app.ready
  await screen("main says hello")
  await screen("Live")
  expect(server.paths()).toEqual(expect.arrayContaining(["/api/session", "/api/event"]))
})

test("persistent records naming another socket, no serverID, a url, no credentials or another version are refused", async () => {
  const record = { version: 2, serverID: "srv_1", socketPath: PERSISTENT_SOCKET, username: "forge", password: "secret" }
  expect(persistentAttach(record)).toEqual({
    url: "http://localhost",
    socketPath: PERSISTENT_SOCKET,
    persistent: true,
    username: "forge",
    password: "secret",
    serverID: "srv_1",
  })
  expect(persistentAttach({ ...record, socketPath: "/tmp/elsewhere.sock" })).toBeUndefined()
  expect(persistentAttach({ ...record, socketPath: "run/turenos/server.sock" })).toBeUndefined()
  expect(persistentAttach({ ...record, serverID: "" })).toBeUndefined()
  expect(persistentAttach({ ...record, url: "http://localhost" })).toBeUndefined()
  expect(persistentAttach({ ...record, password: "" })).toBeUndefined()
  expect(persistentAttach({ ...record, username: "a:b" })).toBeUndefined()
  expect(persistentAttach({ ...record, version: 3 })).toBeUndefined()
  const { servers } = await persistent({ socketPath: "/tmp/elsewhere.sock" })
  await expect(servers.resolve({ kind: "persistent", id: "persistent", name: "Persistent server" })).rejects.toThrow(
    "attach record is missing or unreadable",
  )
})

test("a version 1 record naming a loopback port gets no credentials sent to whatever holds the port", async () => {
  const seen: string[] = []
  const impostor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (seen.push(request.url), new Response(null)) })
  cleanup.push(() => impostor.stop(true))
  const { servers } = await persistent({ version: 1, url: impostor.url.origin, socketPath: undefined })
  await expect(servers.resolve({ kind: "persistent", id: "persistent", name: "Persistent server" })).rejects.toThrow(
    "attach record is missing or unreadable",
  )
  expect(seen).toEqual([])
})

test("a typed http://localhost never borrows the socket record's credentials", async () => {
  const { servers } = await persistent()
  expect(await servers.trusts("http://localhost")).toBe(false)
})

test("a socket connection needs an absolute socket path and the localhost origin", () => {
  expect(() => connect({ url: "http://localhost", socketPath: "server.sock", password: "secret" })).toThrow(
    "absolute socket path",
  )
  expect(() => connect({ url: "http://127.0.0.1:4097", socketPath: "/run/turenos/server.sock" })).toThrow(
    "origin http://localhost",
  )
})
