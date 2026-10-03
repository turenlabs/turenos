import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createApi } from "../src/api"
import { attachTerminal, DETACH } from "../src/attach"
import { cleanup, until } from "./support"

/** A PTY endpoint that behaves like the server's: ticketed WebSocket, replay, cursor frame, echo. */
function pty(options: { drop?: boolean } = {}) {
  const tickets = new Set<string>()
  const connects: URL[] = []
  const received: string[] = []
  let drops = options.drop ? 1 : 0
  const server = Bun.serve<{ url: URL }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/api/pty/pty_1/connect-token" && request.method === "POST") {
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
  return { url: new URL(server.url.origin), connects, received }
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
