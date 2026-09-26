import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { EventV2 } from "@turenlabs/core/event"
import { resetProbeCache } from "@turenlabs/core/plugin/provider/claude-code"
import { McpEvent } from "@turenlabs/schema/mcp-event"
import { Effect, Option } from "effect"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const emitConfigUpdated = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.ConfigUpdated.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean; mcpServer?: string; excludeDirectory?: string }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      resetProbeCache()
      const dispose = options?.excludeDirectory ? store.disposeAllExcept(options.excludeDirectory) : store.disposeAll()
      yield* options?.swallowErrors
        ? dispose.pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : dispose
      if (options?.mcpServer) {
        const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
        // Global MCP config affects every Location. Publish without a location so
        // existing tool registries all replace definitions that reference disposed clients.
        if (events) yield* events.publish(McpEvent.ToolsChanged, { server: options.mcpServer }).pipe(Effect.ignore)
      }
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

// A config write should refresh per-instance service state without tearing the
// instances down: caches rebuild lazily with the new config and clients get a
// quiet `config.updated` instead of a `global.disposed` that re-bootstraps the UI.
export const invalidateInstanceStatesAndEmitConfigUpdated = Effect.fn(
  "Server.invalidateInstanceStatesAndEmitConfigUpdated",
)(function* (options?: { swallowErrors?: boolean }) {
  const store = yield* InstanceStore.Service
  yield* Effect.gen(function* () {
    resetProbeCache()
    yield* options?.swallowErrors
      ? store
          .invalidateStates()
          .pipe(Effect.catchCause((cause) => Effect.logWarning("instance state invalidation failed", { cause })))
      : store.invalidateStates()
    yield* emitConfigUpdated
  }).pipe(Effect.uninterruptible)
})

export * as GlobalLifecycle from "./global-lifecycle"
