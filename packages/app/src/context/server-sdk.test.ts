import { describe, expect, spyOn, test } from "bun:test"
import { createServer } from "node:http"
import { createRoot } from "solid-js"
import {
  coalesceServerEvents,
  createServerSdkContext,
  enqueueServerEvent,
  resumeStreamAfterPageShow,
} from "./server-sdk"
import { ServerScope } from "@/utils/server-scope"
import type { Event } from "@turenlabs/sdk/v2/client"

test("reconnects promptly after a stream drops and resumes from the last live event", async () => {
  const reconnect = Promise.withResolvers<string>()
  const replay = Promise.withResolvers<void>()
  const frame = (payload: { type: string; id: string }) => `data: ${JSON.stringify({ payload })}\n\n`
  let disconnect: (() => void) | undefined
  let connections = 0
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Headers", "Last-Event-ID")
      response.end()
      return
    }
    connections++
    if (connections === 1) {
      response.writeHead(503, "Sensitive fixture detail").end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (connections > 2) {
      reconnect.resolve(String(request.headers["last-event-id"] ?? ""))
      response.end(frame({ type: "lsp.updated", id: "replayed" }))
      return
    }
    const events = [
      { type: "server.connected", id: "synthetic-connected" },
      { type: "lsp.updated", id: "last-live" },
      { type: "sync", id: "sync-only" },
      { type: "server.heartbeat", id: "synthetic-heartbeat" },
    ]
    disconnect = () => response.destroy()
    response.write(events.map(frame).join(""))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP server")
  const logged = spyOn(console, "error").mockImplementation(() => {})
  const dispose = createRoot((dispose) => {
    const sdk = createServerSdkContext(
      { type: "http", http: { url: `http://127.0.0.1:${address.port}` } },
      ServerScope.local,
    )
    sdk.event.on("global", (event) => {
      if (event.id === "synthetic-heartbeat") disconnect?.()
      if (event.id === "replayed") replay.resolve()
    })
    void sdk.event.start()
    return dispose
  })
  try {
    const resumed = Promise.all([reconnect.promise, replay.promise]).then(([cursor]) => cursor)
    expect(await Promise.race([resumed, Bun.sleep(2_000).then(() => "timed out")])).toBe("last-live")
    const streamLogs = logged.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith("[global-sdk]"))
    expect(streamLogs).toContain("[global-sdk] event stream error (webview, HTTP 503)")
    expect(streamLogs.join("\n")).not.toContain("Sensitive fixture detail")
  } finally {
    dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    logged.mockRestore()
  }
})

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
