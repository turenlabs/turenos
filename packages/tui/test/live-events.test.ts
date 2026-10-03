import { expect, spyOn, test } from "bun:test"
import { liveEvents } from "../src/live-events"

const connected = { id: "evt_ready", type: "server.connected", data: {} }
const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const sseHeaders = { "Content-Type": "text/event-stream" }

function fixture() {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let request: Request | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
    },
    cancel() {
      cancelled = true
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(value) {
      request = value
      return new Response(body, { headers: sseHeaders })
    },
  })
  const abort = new AbortController()
  const headers = new Headers({ Authorization: "Basic synthetic-only", Accept: "application/json" })
  const events = liveEvents(new URL("/ignored?secret=not-forwarded", server.url), headers, abort.signal)[
    Symbol.asyncIterator
  ]()
  return {
    events,
    headers,
    abort,
    body,
    get request() {
      return request
    },
    get cancelled() {
      return cancelled
    },
    send(value: string | Uint8Array) {
      stream.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : value)
    },
    close() {
      stream.close()
    },
    async stop() {
      abort.abort()
      await events.return?.()
      await server.stop(true)
    },
  }
}

test("live events yield the first frame without EOF and preserve request headers", async () => {
  const f = fixture()
  try {
    f.send(encode(connected))
    expect(await f.events.next()).toEqual({ value: connected, done: false })
    expect(new URL(f.request!.url).pathname).toBe("/api/event")
    expect(new URL(f.request!.url).search).toBe("")
    expect(f.request!.headers.get("accept")).toBe("text/event-stream")
    expect(f.request!.headers.get("authorization")).toBe("Basic synthetic-only")
    expect(f.headers.get("accept")).toBe("application/json")
    expect(f.cancelled).toBe(false)
    f.send(encode({ ...connected, id: "evt_second" }))
    expect((await f.events.next()).value?.id).toBe("evt_second")
  } finally {
    await f.stop()
  }
}, 3000)

test("live events accept split UTF-8, CRLF, comments, multiline data and unknown types", async () => {
  const f = fixture()
  const event = {
    id: "evt_future",
    type: "future.event",
    data: { delta: "\u2603" },
    durable: { aggregateID: "ses_test", seq: 0, version: 1 },
  }
  try {
    const text =
      ': heartbeat\r\nevent: ignored\r\ndata: {"id":"evt_future",\r\ndata: "type":"future.event",\r\ndata: "data":{"delta":"\u2603"},"durable":{"aggregateID":"ses_test","seq":0,"version":1},"metadata":{"unused":true}}\r\n\r\n'
    const pending = f.events.next()
    for (const byte of new TextEncoder().encode(text)) {
      f.send(new Uint8Array([byte]))
      await Bun.sleep(1)
    }
    expect((await pending).value).toEqual(event)
  } finally {
    await f.stop()
  }
})

test("live events refuse foreign redirects without forwarding credentials", async () => {
  let forwarded = false
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      forwarded = true
      return new Response(encode(connected), { headers: sseHeaders })
    },
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(target.url) })
  try {
    const events = liveEvents(
      server.url,
      new Headers({ Authorization: "Basic synthetic-only" }),
      new AbortController().signal,
    )
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("Live events connection failed")
    expect(forwarded).toBe(false)
  } finally {
    await Promise.all([server.stop(true), target.stop(true)])
  }
})

for (const [label, payload] of [
  ["malformed JSON", "data: {broken}\n\n"],
  ["deep JSON", `data: {"id":"evt_test","type":"test","data":{"nested":${"[".repeat(65)}0${"]".repeat(65)}}}\n\n`],
  ["oversized unterminated frame", `data: ${"x".repeat(1024 * 1024)}`],
  ["oversized comment frame", `: ${"x".repeat(1024 * 1024)}\n\n`],
  ["invalid id", encode({ ...connected, id: [] })],
  ["invalid type", encode({ ...connected, type: "bad\nname" })],
  ["invalid data", encode({ ...connected, data: [] })],
  ["invalid sequence", encode({ ...connected, durable: { aggregateID: "ses_test", seq: -1, version: 1 } })],
  ["invalid version", encode({ ...connected, durable: { aggregateID: "ses_test", seq: 0, version: 0.5 } })],
  ["invalid aggregate", encode({ ...connected, durable: { aggregateID: null, seq: 0, version: 1 } })],
] as const) {
  test(`live events reject ${label}`, async () => {
    const f = fixture()
    try {
      f.send(payload)
      await expect(f.events.next()).rejects.toThrow("Invalid server response")
    } finally {
      await f.stop()
    }
  })
}

test("live events do not impose an 8 MiB lifetime cap", async () => {
  const f = fixture()
  try {
    for (let index = 0; index < 18; index++) {
      f.send(encode({ ...connected, data: { text: "x".repeat(512 * 1024) } }))
      expect((await f.events.next()).value?.data.text).toHaveLength(512 * 1024)
    }
    f.close()
    expect((await f.events.next()).done).toBe(true)
  } finally {
    await f.stop()
  }
})

for (const pendingRead of [false, true]) {
  test(`abort cancels an open stream ${pendingRead ? "during read" : "while paused at yield"}`, async () => {
    const f = fixture()
    try {
      f.send(encode(connected))
      await f.events.next()
      const pending = pendingRead ? f.events.next() : undefined
      f.abort.abort()
      if (pending) await expect(pending).rejects.toThrow("Live events aborted")
      for (let attempt = 0; attempt < 100 && !f.cancelled; attempt++) await Bun.sleep(10)
      expect(f.cancelled).toBe(true)
      expect(f.body.locked).toBe(false)
    } finally {
      await f.stop()
    }
  }, 3000)
}

test("header deadline is 10 seconds and abort clears it", async () => {
  const timeout = spyOn(globalThis, "setTimeout")
  const clear = spyOn(globalThis, "clearTimeout")
  const response = Promise.withResolvers<Response>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.promise })
  const abort = new AbortController()
  const events = liveEvents(server.url, new Headers(), abort.signal)[Symbol.asyncIterator]()
  try {
    const pending = events.next()
    const index = timeout.mock.calls.findIndex((call) => call[1] === 10000)
    expect(index).toBeGreaterThanOrEqual(0)
    const callback = timeout.mock.calls[index]![0]
    expect(typeof callback).toBe("function")
    if (typeof callback === "function") callback()
    await expect(pending).rejects.toThrow("Live events timed out")
    expect(clear.mock.calls.some((call) => call[0] === timeout.mock.results[index]!.value)).toBe(true)
  } finally {
    abort.abort()
    response.resolve(new Response(null, { status: 204 }))
    await events.return?.()
    await server.stop(true)
    timeout.mockRestore()
    clear.mockRestore()
  }
})

test("45-second idle deadline resets on heartbeat chunks and clears on abort", async () => {
  const timeout = spyOn(globalThis, "setTimeout")
  const clear = spyOn(globalThis, "clearTimeout")
  const f = fixture()
  try {
    f.send(encode(connected))
    await f.events.next()
    const count = timeout.mock.calls.filter((call) => call[1] === 45000).length
    expect(count).toBeGreaterThan(0)
    const pending = f.events.next()
    f.send(": heartbeat\n\n")
    for (let attempt = 0; attempt < 100; attempt++) {
      if (timeout.mock.calls.filter((call) => call[1] === 45000).length > count) break
      await Bun.sleep(10)
    }
    expect(timeout.mock.calls.filter((call) => call[1] === 45000).length).toBeGreaterThan(count)
    const index = timeout.mock.calls.findLastIndex((call) => call[1] === 45000)
    const callback = timeout.mock.calls[index]![0]
    if (typeof callback === "function") callback()
    await expect(pending).rejects.toThrow("Live events timed out")
    expect(clear.mock.calls.some((call) => call[0] === timeout.mock.results[index]!.value)).toBe(true)
  } finally {
    await f.stop()
    timeout.mockRestore()
    clear.mockRestore()
  }
})
