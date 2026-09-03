export * as McpToolSource from "./tool-source"

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { makeGlobalNode } from "@turenlabs/core/effect/app-node"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ToolFailure } from "@turenlabs/llm"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { Effect, Layer } from "effect"
import { MCP } from "."
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceStore } from "@/project/instance-store"
import { McpIntegration } from "./integration"
import { McpBroker } from "./broker"

/**
 * Fills Core's MCP tool port from the one MCP service this process owns.
 *
 * There is deliberately no second MCP client here. The invariant is that exactly one
 * MCP service is live per process — each one spawns a child per configured server, and
 * duplicates are invisible until they turn up orphaned — so this reads the connections
 * the V1 graph already holds and hands Core only a listing and a call function. When
 * V1's registry goes away, this file and `MCP.Service` are the only MCP code that has
 * to survive.
 *
 * `MCP.Service` state is keyed by directory through `InstanceState`, which resolves the
 * directory from `InstanceRef` on the calling fiber. A V2 Location fiber carries no
 * `InstanceRef`, so every call is wrapped in `InstanceStore.provide` using the directory
 * the Location asked about.
 */
const layer = Layer.effect(
  McpTool.Source,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const instances = yield* InstanceStore.Service

    const entries = Effect.fn("McpToolSource.entries")(function* (directory: string) {
      return yield* instances.provide({ directory }, mcp.tools()).pipe(
        Effect.tapError(() => Effect.logWarning("failed to list MCP tools", { directory })),
        Effect.orElseSucceed(() => ({}) as Record<string, MCP.McpTool>),
      )
    })
    const catalogs = new Map<
      string,
      {
        readonly listed: Readonly<Record<string, MCP.McpTool>>
        readonly definitions: ReadonlyArray<McpTool.Definition>
      }
    >()

    const capability = (key: string, entry: MCP.McpTool) =>
      McpBroker.capability({
        key,
        server: entry.server,
        name: entry.def.name,
        description: entry.def.description,
      })

    const definitionCapability = (definition: McpTool.Definition): McpTool.Capability => ({
      key: definition.key,
      server: definition.server,
      name: definition.name,
      description: definition.description,
      maxLoadedTools: definition.maxLoadedTools,
      unloadAfterIdleTurns: definition.unloadAfterIdleTurns,
    })

    const inventory = Effect.fn("McpToolSource.inventory")(function* (input: {
      readonly directory: string
      readonly definitions?: ReadonlyArray<McpTool.Definition>
    }) {
      const listed = input.definitions ? undefined : yield* entries(input.directory)
      const statuses = yield* instances.provide({ directory: input.directory }, mcp.status())
      const capabilities = input.definitions
        ? input.definitions.map(definitionCapability)
        : Object.entries(listed ?? {}).map(([key, entry]) => capability(key, entry))
      const servers = Object.entries(statuses).map(([id, status]) => ({
        id,
        status:
          status.status === "needs_auth"
            ? ("needs-auth" as const)
            : status.status === "needs_client_registration" || status.status === "failed"
              ? ("failed" as const)
              : status.status === "connected" || status.status === "connecting" || status.status === "disabled"
                ? status.status
                : ("unknown" as const),
        definitions: capabilities.filter((item) => item.server === id).length,
        ...(status.status === "failed" || status.status === "needs_client_registration"
          ? { detail: "MCP connection failed" }
          : {}),
      }))
      type InventoryExclusion = McpTool.Inventory["exclusions"][number]
      const exclusions = servers.flatMap((server): InventoryExclusion[] => {
        if (server.status === "connected") {
          if (server.definitions > 0) return []
          const integration = McpIntegration.definition(server.id)
          return [
            {
              server: server.id,
              reason:
                integration && McpIntegration.contribution(integration.id).item.tools.allow.length > 0
                  ? ("manifest-allowlist-denied" as const)
                  : ("no-definitions" as const),
            },
          ]
        }
        const reason: McpTool.ExclusionReasonCode =
          server.status === "needs-auth"
            ? "needs-auth"
            : server.status === "connecting"
              ? "connecting"
              : server.status === "disabled"
                ? "disabled"
                : "failed"
        return [{ server: server.id, reason }]
      })
      return {
        observedAt: Date.now(),
        servers,
        capabilities,
        exclusions,
      } satisfies McpTool.Inventory
    })

    return McpTool.Source.of({
      list: Effect.fn("McpToolSource.list")(function* (input) {
        const listed = yield* entries(input.directory)
        const cached = catalogs.get(input.directory)
        if (cached && sameListing(cached.listed, listed)) return cached.definitions
        const definitions = Object.entries(listed).map(([key, entry]): McpTool.Definition => {
          const approved = capability(key, entry)
          return {
            ...approved,
            server: entry.server,
            name: entry.def.name,
            description: approved.description,
            confirmationRequired: McpIntegration.requiresConfirmation(entry.server),
            inputSchema: entry.def.inputSchema as McpTool.Definition["inputSchema"],
            call: (args) =>
              Effect.gen(function* () {
                const configuration =
                  entry.server !== "onepassword" && McpIntegration.definition(entry.server) !== undefined
                    ? yield* instances.provide({ directory: input.directory }, mcp.configuration(entry.server))
                    : undefined
                return yield* Effect.tryPromise({
                  // The signal is Effect's own interruption signal, so cancelling a run
                  // cancels the in-flight MCP request rather than leaking it.
                  try: (signal) =>
                    entry.client
                      .callTool({ name: entry.def.name, arguments: args }, CallToolResultSchema, {
                        resetTimeoutOnProgress: true,
                        signal,
                        timeout: entry.timeout,
                        // Progress resets are open-ended: a server that keeps emitting
                        // notifications/progress would otherwise hold the call — and the
                        // turn — forever. The total cap bounds the whole call regardless.
                        maxTotalTimeout: Math.max((entry.timeout ?? 0) * 10, 600_000),
                        // The SDK only sends a progress token when this hook exists, and
                        // without one a long call cannot reset its timeout at all.
                        onprogress: () => {},
                      })
                      .then((result) => McpIntegration.redactMcpResult(entry.server, configuration, result)),
                  catch: (error) =>
                    new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
                })
              }),
          }
        })
        catalogs.set(input.directory, { listed, definitions })
        return definitions
      }),
      inventory,
      begin: (input) => Effect.sync(() => McpBroker.beginTurn(input.sessionID, input.capabilities, input.directory)),
      selected: (input) =>
        Effect.sync(() =>
          McpBroker.selected(input.sessionID, input.capabilities, input.directory).map((item) => item.key),
        ),
      search: (input) =>
        Effect.sync(() => McpBroker.search(input.sessionID, input.capabilities, input.query, input.directory)),
      load: (input) =>
        Effect.try({
          try: () => McpBroker.load(input.sessionID, input.capabilities, input.tools, input.directory),
          catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        }),
      touch: (input) => Effect.sync(() => McpBroker.touch(input.sessionID, input.key, input.directory)),
    })
  }),
)

function sameListing(left: Readonly<Record<string, MCP.McpTool>>, right: Readonly<Record<string, MCP.McpTool>>) {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => {
    const before = left[key]
    const after = right[key]
    return (
      before !== undefined &&
      after !== undefined &&
      before.client === after.client &&
      before.def === after.def &&
      before.server === after.server &&
      before.timeout === after.timeout
    )
  })
}

/**
 * Global on purpose. `buildLocationServiceMap` builds Location-scoped layers under
 * `Layer.fresh`, which uses a private memo map — a Location-scoped node here would
 * construct a second MCP service for every open directory. Global nodes are hoisted out
 * of that wrapper, so this is built once and shares the memoized `MCP.node`
 * implementation with the V1 graph in the same listener.
 */
export const node = makeGlobalNode({
  service: McpTool.Source,
  layer: layer.pipe(Layer.provide(AppNodeBuilderV1.build(LayerNode.group([MCP.node, InstanceStore.node])))),
  deps: [],
})

export const legacyNode = makeGlobalNode({
  service: McpTool.Source,
  layer,
  deps: [MCP.node, InstanceStore.node],
})
