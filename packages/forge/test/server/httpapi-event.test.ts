import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { EventV2 } from "@turenlabs/core/event"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AbsolutePath } from "@turenlabs/core/schema"
import { GlobalBus } from "../../src/bus/global"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect, testEffectShared } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

// Publishing into the SSE subscriber requires the same EventV2 instance the
// routes use, so this variant builds through the shared process memoMap.
const itShared = testEffectShared(
  Layer.mergeAll(httpApiLayer, LayerNode.compile(EventV2.node, [[Database.node, Database.layerFromPath(":memory:")]])),
)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-store, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  const Flood = EventV2.define({
    type: "test.flood",
    schema: { text: Schema.String },
  })

  const countOccurrences = (chunks: Iterable<Uint8Array>, needle: string) => {
    const decoder = new TextDecoder()
    let count = 0
    for (const chunk of chunks) {
      count += (decoder.decode(chunk).match(new RegExp(needle, "g")) ?? []).length
    }
    return count
  }

  itShared.instance(
    "terminates a stalled event stream instead of buffering events without bound",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const response = yield* requestInDirectory(EventPaths.event, directory)
        expect(response.status).toBe(200)

        const events = yield* EventV2.Service
        // Publishing non-durable events is synchronous, so the runSync flood
        // cannot interleave with the SSE consumer: a stalled subscriber's queue
        // fills to capacity and the stream is dropped rather than growing
        // without bound.
        for (let i = 0; i < 512; i++) {
          Effect.runSync(
            events.publish(Flood, { text: `flood-${i}` }, { location: { directory: AbsolutePath.make(directory) } }),
          )
        }

        const collected = yield* awaitWithTimeout(
          response.stream.pipe(Stream.runCollect, Effect.exit),
          "event stream never terminated after subscriber overflow",
          "10 seconds",
        )
        // Overflow ends the connection whether the transport surfaces the drop as
        // an error or a close — the client reconnects either way.
        const delivered = Exit.isSuccess(collected) ? countOccurrences(collected.value, '"test\\.flood"') : 0
        expect(delivered).toBeGreaterThan(0)
        expect(delivered).toBeLessThanOrEqual(300)

        // The subscriber was dropped, not the server: a fresh connection still works.
        const reconnect = yield* openEventStream(directory)
        expect(yield* readEvent(reconnect.reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("terminates a stalled global event stream instead of buffering events without bound", () =>
    Effect.gen(function* () {
      const response = yield* request(GlobalPaths.event)
      expect(response.status).toBe(200)
      const reader = yield* Queue.unbounded<Uint8Array>()
      const terminated = yield* Deferred.make<Exit.Exit<void, unknown>>()
      yield* response.stream.pipe(
        Stream.runForEach((value) => Queue.offer(reader, value)),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.succeed(terminated, exit)),
        Effect.forkScoped,
      )

      // The GlobalBus listener registers when the response stream materializes;
      // emit probes until one arrives before flooding.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          GlobalBus.emit("event", { directory: "probe", payload: { type: "test.probe" } })
          const chunk = yield* Queue.take(reader).pipe(
            Effect.timeoutOrElse({ duration: "50 millis", orElse: () => Effect.succeed(undefined) }),
          )
          return chunk !== undefined && new TextDecoder().decode(chunk).includes("test.probe")
            ? (true as const)
            : undefined
        }),
        "global event stream never delivered the probe event",
      )

      // GlobalBus.emit is synchronous, so the flood cannot interleave with the
      // SSE consumer: the subscriber queue fills to capacity and the stream is
      // dropped rather than growing without bound.
      for (let i = 0; i < 512; i++) {
        GlobalBus.emit("event", { directory: "flood", payload: { type: "test.flood" } })
      }

      yield* awaitWithTimeout(Deferred.await(terminated), "global event stream never terminated", "10 seconds")
      const delivered = countOccurrences(yield* Queue.takeAll(reader), "test\\.flood")
      expect(delivered).toBeGreaterThan(0)
      expect(delivered).toBeLessThanOrEqual(300)
    }),
  )
})
