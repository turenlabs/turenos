import { expect, test } from "bun:test"
import { mergeLive } from "../src/conversation/live-cache"
import { transcriptBlocks } from "../src/messages"
import { assistant, dashboard, until } from "./support"

const step = (id: string, created: number, completed?: number, text = id) =>
  assistant(id, text, { time: { created, ...(completed === undefined ? {} : { completed }) }, finish: "tool-calls" })

function conversation() {
  return {
    state: { selected: "ses_a", expandToolOutput: false, snapshot: { sessions: [{ id: "ses_a" }] } },
    live: new Map(),
    positions: new Map(),
    hooks: { say: () => {} },
    generation: 0,
  }
}

test("an evicted turn header keeps the duration of all retained steps", () => {
  const evicted = step("evicted", 0, 1000)
  evicted.content = Array.from({ length: 8 }, (_, index) => ({ id: `text_big${index}`, type: "text", text: "x".repeat(15000) }))
  const messages = [evicted, step("first", 1000, 2000), step("last", 2000, 9000)]
  const c = conversation()
  const cached = mergeLive(c as never, messages as never)
  expect(cached.capped).toBe(true)
  expect(cached.messages[0]!.id).toBe("msg_first")
  expect(cached.messages[0]!.formatted).toBe(transcriptBlocks(messages.slice(1) as never, false, true)[0]!.text)
  expect(cached.messages[0]!.formatted).toContain("8s")
})

test("a partial page updates a retained header when later steps complete", () => {
  const c = conversation()
  const first = step("first", 1000, 2000)
  const pending = step("last", 2000)
  mergeLive(c as never, [first, pending] as never)
  const last = step("last", 2000, 9000, "completed later")
  const cached = mergeLive(c as never, [last] as never)
  expect(cached.messages.map((item) => item.id)).toEqual(["msg_first", "msg_last"])
  expect(cached.messages[0]!.formatted).toBe(transcriptBlocks([first, last] as never, false, true)[0]!.text)
  expect(cached.messages[0]!.formatted).toContain("8s")
  expect(cached.messages[1]!.formatted).toContain("completed later")
})

test("a lost frame reloads the displayed transcript and later deltas continue", async () => {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
  const data = { text: "Before loss", reads: 0 }
  const app = await dashboard({
    "GET /api/event": () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streams.add(controller)
        controller.enqueue(frame({ id: "evt_connected", type: "server.connected", data: {} }))
      },
      cancel() { streams.clear() },
    }), { headers: { "content-type": "text/event-stream" } }),
    "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }),
    "GET /api/session/ses_main/message": () => {
      data.reads++
      return { data: [assistant("main", data.text, { time: { created: 1 }, finish: undefined })], cursor: {} }
    },
  })
  await app.screen("Before loss")
  await until(() => data.reads >= 2 && streams.size > 0)
  const emit = (id: string, delta: string) => streams.forEach((stream) => stream.enqueue(frame({
    id, type: "session.next.text.delta",
    data: { sessionID: "ses_main", assistantMessageID: "msg_main", textID: "text_main", delta, timestamp: 2 },
  })))
  emit("evt_before", " transient overlay")
  await app.screen("transient overlay")
  const before = data.reads
  data.text = "Recovered server transcript"
  streams.forEach((stream) => stream.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1024 * 1024 + 10)}\n\n`)))
  await app.screen("Recovered server transcript")
  expect(data.reads).toBeGreaterThan(before)
  expect(app.view.captureCharFrame()).not.toContain("transient overlay")
  emit("evt_after", " resumed delta")
  await app.screen("resumed delta")
})
