import { describe, expect } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { McpEvent } from "@turenlabs/schema/mcp-event"
import { Deferred, Effect, Layer } from "effect"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "../../src/server/global-lifecycle"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const disposed = { count: 0 }
const it = testEffect(
  Layer.merge(
    LayerNode.compile(EventV2.node, [[Database.node, Database.layerFromPath(":memory:")]]),
    Layer.mock(InstanceStore.Service)({
      disposeAll: () => Effect.sync(() => disposed.count++),
    }),
  ),
)

describe("global lifecycle", () => {
  it.live("invalidates every Location after disposing clients for a global MCP change", () =>
    Effect.gen(function* () {
      disposed.count = 0
      const events = yield* EventV2.Service
      const received = yield* Deferred.make<{ server: string; location: unknown }>()
      const unsubscribe = yield* events.listen((event) => {
        if (
          event.type !== McpEvent.ToolsChanged.type ||
          typeof event.data !== "object" ||
          event.data === null ||
          !("server" in event.data) ||
          typeof event.data.server !== "string"
        )
          return Effect.void
        return Deferred.succeed(received, { server: event.data.server, location: event.location }).pipe(Effect.asVoid)
      })

      yield* disposeAllInstancesAndEmitGlobalDisposed({ mcpServer: "notion" })
      const event = yield* awaitWithTimeout(Deferred.await(received), "global MCP invalidation was not published")
      yield* unsubscribe

      expect(disposed.count).toBe(1)
      expect(event.server).toBe("notion")
      expect(event.location).toBeUndefined()
    }),
  )
})
