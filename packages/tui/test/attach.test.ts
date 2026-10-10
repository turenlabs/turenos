import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApi } from "../src/api"
import { attachTerminal, DETACH, RESTORE } from "../src/attach"
import { connect } from "../src/server"
import { cleanup, until } from "./support"

/**
 * A PTY endpoint that behaves like the server's: ticketed WebSocket, replay, cursor frame, echo. It listens on a
 * loopback port, or on the Unix socket `socket` as a persistent server does.
 */
function pty(options: { drop?: boolean; gone?: boolean; flaky?: boolean; socket?: string } = {}) {
  const tickets = new Set<string>()
  const connects: URL[] = []
  const received: string[] = []
  let drops = options.drop ? 1 : 0
  let flaked = false
  const server = Bun.serve<{ url: URL }>({
    ...(options.socket ? { unix: options.socket } : { hostname: "127.0.0.1", port: 0 }),
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/api/pty/pty_1/connect-token" && request.method === "POST") {
        // The PTY ended while the client was disconnected.
        if (options.gone && connects.length > 0) return new Response(null, { status: 404 })
        // The server is restarting: the first reconnect's ticket request fails, the next succeeds.
        if (options.flaky && connects.length > 0 && !flaked) {
          flaked = true
          return new Response(null, { status: 503 })
        }
        if (request.headers.get("x-forge-ticket") !== "1") return new Response(null, { status: 403 })
        const ticket = crypto.randomUUID()
        tickets.add(ticket)
        return Response.json({ location: { directory: "/srv" }, data: { ticket, expires_in: 60 } })
      }
      if (url.pathname === "/api/pty/pty_1/connect") {
        // Tickets are single use, as on the server.
        if (!tickets.delete(url.searchParams.get("ticket") ?? "")) return new Response(null, { status: 403 })
        connects.push(url)
        return server.upgrade(request, { data: { url } }) ? undefined : new Response(null, { status: 400 })
      }
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) {
        if (!socket.data.url.searchParams.has("cursor")) socket.send("$ hello\r\n")
        socket.send(new Uint8Array([0, ...new TextEncoder().encode(JSON.stringify({ cursor: 9 }))]))
        if (drops-- > 0) socket.close(1011, "restart")
      },
      message(socket, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message)
        received.push(text)
        if (text.includes("exit")) return socket.close(1000, "exited")
        socket.send(text)
      },
    },
  })
  cleanup.push(() => server.stop(true))
  return { url: new URL(options.socket ? "http://localhost" : server.url.origin), connects, received }
}

function io() {
  const stdin = new EventEmitter()
  const output = Object.assign(new EventEmitter(), {
    text: "",
    columns: 100,
    rows: 30,
    write(chunk: string) {
      output.text += chunk
      return true
    },
  })
  return { stdin, stdout: output }
}

function attach(server: ReturnType<typeof pty>, terminal: ReturnType<typeof io>, sizes: unknown[] = []) {
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  return attachTerminal({
    url: server.url,
    api: createApi({ url: server.url, headers: new Headers(), signal: controller.signal }),
    resize: async (size) => void sizes.push(size),
    target: { id: "pty_1", title: "shell", directory: "/srv" },
    stdin: terminal.stdin,
    stdout: terminal.stdout,
  })
}

test("attach replays output, sends keystrokes as text, follows resizes, and Ctrl+] detaches", async () => {
  const server = pty()
  const terminal = io()
  const sizes: unknown[] = []
  const attached = attach(server, terminal, sizes)
  await until(() => terminal.stdout.text.includes("$ hello"))
  expect(server.connects[0]?.searchParams.get("location[directory]")).toBe("/srv")
  expect(server.connects[0]?.searchParams.has("cursor")).toBe(false)
  await until(() => sizes.length === 1)
  expect(sizes[0]).toEqual({ rows: 30, cols: 100 })
  // A multibyte character split across two reads still arrives whole.
  const bytes = Buffer.from("ls é\r")
  terminal.stdin.emit("data", bytes.subarray(0, 4))
  terminal.stdin.emit("data", bytes.subarray(4))
  await until(() => terminal.stdout.text.includes("é"))
  expect(server.received.join("")).toBe("ls é\r")
  terminal.stdout.columns = 80
  terminal.stdout.emit("resize")
  await until(() => sizes.length === 2)
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect(await attached).toEqual({ reason: "detached" })
  expect(terminal.stdin.listenerCount("data")).toBe(0)
})

test("a server on a Unix socket is attached through that socket, as its connection reaches it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tui-attach-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = pty({ socket: join(directory, "server.sock") })
  const connection = connect({ url: "http://localhost", socketPath: join(directory, "server.sock") })
  cleanup.push(connection.close)
  const terminal = io()
  const attached = attachTerminal({
    url: connection.url,
    socketPath: connection.socketPath,
    api: connection.api,
    resize: async () => undefined,
    target: { id: "pty_1", title: "shell", directory: "/srv" },
    stdin: terminal.stdin,
    stdout: terminal.stdout,
  })
  await until(() => terminal.stdout.text.includes("$ hello"))
  expect(server.connects[0]?.searchParams.get("location[directory]")).toBe("/srv")
  terminal.stdin.emit("data", "ls\r")
  await until(() => server.received.join("") === "ls\r")
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect(await attached).toEqual({ reason: "detached" })
})

test("attach ends when the terminal exits", async () => {
  const server = pty()
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => terminal.stdout.text.includes("$ hello"))
  terminal.stdin.emit("data", "exit\r")
  expect(await attached).toEqual({ reason: "exited" })
})

test("a dropped connection reconnects with a new ticket from the last cursor", async () => {
  const server = pty({ drop: true })
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => server.connects.length === 2)
  expect(server.connects[1]?.searchParams.get("cursor")).toBe("9")
  // The replay was not written twice.
  expect(terminal.stdout.text.split("$ hello").length).toBe(2)
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect((await attached).reason).toBe("detached")
})

test("input typed while reconnecting is kept and sent after the socket reopens", async () => {
  const server = pty({ drop: true })
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => server.connects.length === 1)
  // The reconnect waits 500 ms; keystrokes land while the socket is closed.
  await Bun.sleep(100)
  terminal.stdin.emit("data", "ls")
  terminal.stdin.emit("data", " -l\r")
  await until(() => server.connects.length === 2)
  await until(() => server.received.join("") === "ls -l\r")
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect((await attached).reason).toBe("detached")
})

test("input buffered for a reconnect is bounded", async () => {
  const server = pty({ drop: true })
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => server.connects.length === 1)
  await Bun.sleep(100)
  const chunk = "x".repeat(16 * 1024)
  for (let index = 0; index < 8; index++) terminal.stdin.emit("data", chunk)
  await until(() => server.connects.length === 2)
  await until(() => server.received.length > 0)
  await Bun.sleep(100)
  expect(server.received.join("").length).toBe(64 * 1024)
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  await attached
})

test("a PTY that ended while disconnected reports exited, not failed", async () => {
  const server = pty({ drop: true, gone: true })
  const terminal = io()
  expect(await attach(server, terminal)).toEqual({ reason: "exited" })
})

test("an invalid terminal id rejects instead of throwing before the attachment starts", async () => {
  const server = pty()
  const terminal = io()
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  await expect(
    attachTerminal({
      url: server.url,
      api: createApi({ url: server.url, headers: new Headers(), signal: controller.signal }),
      resize: async () => undefined,
      target: { id: "shell", title: "shell", directory: "/srv" },
      stdin: terminal.stdin,
      stdout: terminal.stdout,
    }),
  ).rejects.toThrow("Invalid server response (identifier).")
  expect(terminal.stdin.listenerCount("data")).toBe(0)
  expect(server.connects).toHaveLength(0)
})

test("a failed ticket request during a reconnect is retried and buffered input still arrives", async () => {
  const server = pty({ drop: true, flaky: true })
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => server.connects.length === 1)
  await Bun.sleep(100)
  terminal.stdin.emit("data", "pwd\r")
  await until(() => server.connects.length === 2)
  await until(() => server.received.join("") === "pwd\r")
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect((await attached).reason).toBe("detached")
})

test.each(["\x1b[93;5u", "\x1b[27;5;93~"])("Ctrl+] detaches in its %j encoding too", async (sequence) => {
  const server = pty()
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => terminal.stdout.text.includes("$ hello"))
  terminal.stdin.emit("data", `ls${sequence}ignored`)
  expect((await attached).reason).toBe("detached")
  await until(() => server.received.join("") === "ls")
})

test("the attachment ends with a terminal reset, so a PTY program's modes do not outlive it", async () => {
  const server = pty()
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => terminal.stdout.text.includes("$ hello"))
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  await attached
  expect(terminal.stdout.text.endsWith(RESTORE)).toBe(true)
})

test("input past the reconnect limit is dropped as a whole, not resumed after a gap", async () => {
  const server = pty({ drop: true })
  const terminal = io()
  const attached = attach(server, terminal)
  await until(() => server.connects.length === 1)
  await Bun.sleep(100)
  for (let index = 0; index < 3; index++) terminal.stdin.emit("data", "x".repeat(16 * 1024))
  terminal.stdin.emit("data", "y".repeat(32 * 1024))
  terminal.stdin.emit("data", "tail")
  await until(() => server.connects.length === 2)
  await until(() => server.received.length > 0)
  await Bun.sleep(100)
  expect(server.received.join("")).toBe("x".repeat(48 * 1024))
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  await attached
})

test("a socket the constructor refuses is retried instead of leaving the attachment pending", async () => {
  const server = pty()
  const terminal = io()
  const refusals = { left: 1 }
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const attached = attachTerminal({
    url: server.url,
    api: createApi({ url: server.url, headers: new Headers(), signal: controller.signal }),
    resize: async () => undefined,
    target: { id: "pty_1", title: "shell", directory: "/srv" },
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    socket: (url) => {
      if (refusals.left-- > 0) throw new Error("refused")
      return new WebSocket(url)
    },
  })
  await until(() => terminal.stdout.text.includes("$ hello"))
  terminal.stdin.emit("data", Buffer.from([DETACH]))
  expect((await attached).reason).toBe("detached")
})
