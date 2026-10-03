import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { MarkdownRenderable } from "@opentui/core"
import type { SessionsTaskListOutput } from "@turenlabs/client"
import { mountDashboard } from "../src/index"
import { connect, type Session } from "../src/server"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

async function fixture(deferredReady = false, initialText = "Initial snapshot") {
  const session: Session = {
    id: "ses_live",
    projectID: "project",
    title: "Live conversation",
    agent: "build",
    location: { directory: "/fixture" },
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const data = {
    text: initialText,
    available: true,
    tasks: { data: [], active: [], cursor: {} } as SessionsTaskListOutput,
    revert: undefined as Session["revert"],
    tail: undefined as string | undefined,
  }
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let connections = 0
  let reads = 0
  let sequence = 0
  const encode = (type: string, value: Record<string, unknown>) =>
    new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${++sequence}`, type, data: value })}\n\n`)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/event") {
        if (!data.available) return new Response(null, { status: 503 })
        connections++
        let controller: ReadableStreamDefaultController<Uint8Array>
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value
              streams.add(value)
              if (!deferredReady) value.enqueue(encode("server.connected", {}))
            },
            cancel() {
              streams.delete(controller)
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }
      if (path === "/api/location")
        return Response.json({ directory: "/fixture", project: { id: "project", directory: "/fixture" } })
      if (path === "/api/session") return Response.json({ data: [{ ...session, revert: data.revert }], cursor: {} })
      if (path === "/api/session/active") return Response.json({ data: { ses_live: { type: "running" } } })
      if (path === "/api/pty") return Response.json({ location: { directory: "/fixture" }, data: [] })
      if (path === "/api/loop") return Response.json([])
      if (path === "/api/session/ses_live") return Response.json({ data: { ...session, revert: data.revert } })
      if (path.endsWith("/message")) {
        reads++
        return Response.json({
          data: [
            ...(data.tail ? [{ id: "msg_tail", type: "user", text: data.tail, time: { created: 2 } }] : []),
            {
              id: "msg_live",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "model" },
              time: { created: 1 },
              content: [{ id: "text_live", type: "text", text: data.text }],
            },
          ],
          cursor: {},
        })
      }
      if (path.endsWith("/task")) return Response.json(data.tasks)
      if (["permission", "question", "input"].includes(path.split("/").at(-1)!)) return Response.json({ data: [] })
      return new Response(null, { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, connection, server.url.href)
  await app.ready
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (predicate()) return
      await Bun.sleep(10)
    }
    throw new Error(`Expected live state did not arrive:\n${view.captureCharFrame()}`)
  }
  async function screen(text: string) {
    await wait(() => view.captureCharFrame().includes(text))
  }
  function emit(type: string, fields: Record<string, unknown> = {}) {
    for (const stream of streams)
      stream.enqueue(encode(type, { sessionID: session.id, assistantMessageID: "msg_live", timestamp: 2, ...fields }))
  }
  function closeStreams() {
    for (const stream of streams) stream.close()
    streams.clear()
  }
  return {
    data,
    view,
    app,
    wait,
    screen,
    emit,
    closeStreams,
    streams,
    reads: () => reads,
    connections: () => connections,
  }
}

test("live text and tool progress render before snapshots change, including beside a reply draft", async () => {
  const f = await fixture()
  await f.wait(() => f.reads() >= 2)
  await f.screen("Initial snapshot")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " live text" })
  await f.screen("live text")
  expect((f.view.renderer.root.findDescendantById("markdown") as MarkdownRenderable).content).toContain(
    "Initial snapshot live text",
  )
  await f.screen("Initial snapshot live text")
  expect(f.data.text).toBe("Initial snapshot")
  await f.app.refresh()
  await f.screen("Initial snapshot live text")
  f.view.mockInput.pressKey("f")
  await f.view.mockInput.typeText("My unsent reply")
  f.emit("session.next.tool.input.started", { callID: "call_live", name: "read_file" })
  f.emit("session.next.tool.called", {
    callID: "call_live",
    tool: "read_file",
    input: {},
    provider: { executed: false },
  })
  f.emit("session.next.tool.progress", {
    callID: "call_live",
    structured: {},
    content: [{ type: "text", text: "Reading file now" }],
  })
  await f.screen("Reading file now")
  expect(f.view.renderer.currentFocusedEditor?.plainText).toBe("My unsent reply")
  f.emit("session.next.tool.success", {
    callID: "call_live",
    structured: {},
    content: [{ type: "text", text: "Read complete" }],
    provider: { executed: false },
  })
  await f.screen("Read complete")
  expect(f.view.renderer.currentFocusedEditor?.plainText).toBe("My unsent reply")
  f.emit("session.next.text.ended", { textID: "text_live", text: "Authoritative final response" })
  await f.screen("Authoritative final response")
})

test("delayed listener readiness triggers a post-readiness catch-up snapshot", async () => {
  const f = await fixture(true)
  await f.screen("Initial snapshot")
  await f.wait(() => f.streams.size > 0)
  const reads = f.reads()
  f.data.text = "Changed before listener readiness"
  f.emit("server.connected")
  await f.wait(() => f.reads() > reads)
  await f.screen("Changed before listener readiness")
  await f.screen("Live")
})

test("foreign session deltas are ignored and History does not consume live fragments", async () => {
  const f = await fixture()
  await f.wait(() => f.reads() >= 2)
  f.emit("session.next.text.delta", { sessionID: "ses_other", textID: "text_live", delta: " foreign secret" })
  await Bun.sleep(100)
  await f.view.renderOnce()
  expect(f.view.captureCharFrame()).not.toContain("foreign secret")
  f.view.mockInput.pressKey("h")
  await f.screen("History")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " newer live text" })
  await Bun.sleep(100)
  await f.view.renderOnce()
  expect(f.view.captureCharFrame()).not.toContain("newer live text")
  f.data.text = "Initial snapshot newer live text"
  f.view.mockInput.pressKey("h")
  await f.screen("Initial snapshot newer live text")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " plus next" })
  await f.screen("Initial snapshot newer live text plus next")
})

test("stream failure falls back to polling and reconnects with a fresh snapshot", async () => {
  const f = await fixture()
  await f.wait(() => f.reads() >= 2)
  f.data.available = false
  f.data.text = "Catch-up after disconnect"
  f.closeStreams()
  await f.screen("Polling")
  await f.screen("Catch-up after disconnect")
  f.data.text = "Reconnected snapshot"
  f.data.available = true
  await f.wait(() => f.connections() >= 2)
  await f.screen("Reconnected snapshot")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " resumed" })
  await f.screen("Reconnected snapshot resumed")
})

test("an open task roster updates in place without losing its filter or focus", async () => {
  const f = await fixture()
  const task = {
    id: "tsk_worker",
    rootSessionID: "ses_live",
    parentSessionID: "ses_live",
    childSessionID: "ses_child",
    agent: "explore",
    description: "Worker investigation",
    depth: 1,
    status: "running" as const,
    revision: 1,
    time: { created: 1, updated: 1 },
  }
  f.data.tasks = { data: [task], active: [task], cursor: {} }
  await f.app.refresh()
  f.view.mockInput.pressKey("t")
  await f.screen("Worker investigation")
  await f.view.mockInput.typeText("Worker")
  f.data.tasks = { data: [{ ...task, status: "completed", revision: 2 }], active: [], cursor: {} }
  f.emit("session.next.task.updated", { assistantMessageID: undefined, taskID: task.id, task: f.data.tasks.data[0] })
  await f.screen("[completed] Worker investigation")
  expect(f.view.renderer.currentFocusedEditor?.plainText).toBe("Worker")
  expect(f.view.renderer.currentFocusedEditor?.focused).toBe(true)
})

test("streaming grows the transcript without pulling a reader away from older text", async () => {
  const f = await fixture(false, Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n\n"))
  await f.wait(() => f.reads() >= 2)
  await f.screen("Line 79")
  f.view.mockInput.pressEnter()
  f.view.mockInput.pressKey("\x1b[5~")
  await f.view.renderOnce()
  const before = f.view.captureCharFrame().match(/Line \d+/)?.[0]
  expect(before).toBeDefined()
  const markdown = f.view.renderer.root.findDescendantById("markdown") as MarkdownRenderable
  const height = markdown.height
  f.emit("session.next.text.delta", { textID: "text_live", delta: "\n\nStreaming tail" })
  await f.wait(() => markdown.content.includes("Streaming tail") && markdown.height > height)
  await f.view.renderOnce()
  expect(f.view.captureCharFrame().match(/Line \d+/)?.[0]).toBe(before)
  expect(f.view.captureCharFrame()).not.toContain("Streaming tail")
  f.view.mockInput.pressKey("END")
  await f.screen("Streaming tail")
})

test("external undo/redo events refresh metadata and cannot resurrect stale live overlays", async () => {
  const f = await fixture()
  await f.wait(() => f.reads() >= 2)
  f.emit("session.next.text.delta", { textID: "text_live", delta: " transient tail" })
  await f.screen("Initial snapshot transient tail")
  f.data.revert = { messageID: "msg_live", files: [] }
  f.emit("session.next.revert.staged", { assistantMessageID: undefined, revert: f.data.revert })
  await f.screen("UNDO STAGED")
  expect(f.view.captureCharFrame()).not.toContain("transient tail")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " stale after undo" })
  await Bun.sleep(100)
  await f.view.renderOnce()
  expect(f.view.captureCharFrame()).not.toContain("stale after undo")
  f.data.revert = undefined
  f.emit("session.next.revert.cleared", { assistantMessageID: undefined })
  await f.screen("Initial snapshot")
  expect(f.view.captureCharFrame()).not.toContain("transient tail")
  expect(f.view.captureCharFrame()).not.toContain("UNDO STAGED")
  f.emit("session.next.text.delta", { textID: "text_live", delta: " fresh" })
  await f.screen("Initial snapshot fresh")
})

test.each(["events", "reconnect"])(
  "committed-away cached turns disappear after %s even when metadata has no staged boundary",
  async (mode) => {
    const f = await fixture()
    await f.wait(() => f.reads() >= 2)
    f.data.tail = "Committed-away turn"
    await f.app.refresh()
    await f.screen("Committed-away turn")
    const reads = f.reads()
    f.data.tail = undefined
    if (mode === "events") {
      f.emit("session.next.revert.staged", { assistantMessageID: undefined, revert: { messageID: "msg_tail" } })
      f.emit("session.next.revert.committed", { assistantMessageID: undefined, messageID: "msg_tail" })
    } else {
      f.data.available = false
      f.closeStreams()
      await f.screen("Polling")
      f.data.available = true
      await f.wait(() => f.connections() >= 2)
    }
    const content = () => (f.view.renderer.root.findDescendantById("markdown") as MarkdownRenderable).content
    await f.wait(
      () => f.reads() > reads && content().includes("Initial snapshot") && !content().includes("Committed-away turn"),
    )
    await f.view.renderOnce()
    expect(content()).not.toContain("Committed-away turn")
    expect(content()).not.toContain("UNDO STAGED")
  },
)
