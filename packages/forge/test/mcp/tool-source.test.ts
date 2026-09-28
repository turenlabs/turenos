import { describe, expect } from "bun:test"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { Effect, Layer } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpToolSource } from "../../src/mcp/tool-source"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"

const statuses = {
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`server-${index}`, { status: "connected" as const }]),
  ),
  empty: { status: "connected" },
  failed: { status: "failed", error: "offline" },
} satisfies Record<string, MCP.Status>

const sourceLayer = LayerNode.compile(McpToolSource.legacyNode, [
  [MCP.node, Layer.mock(MCP.Service)({ status: () => Effect.succeed(statuses) })],
  [InstanceStore.node, Layer.mock(InstanceStore.Service)({ provide: (_input, effect) => effect })],
])

const sourceTest = testEffect(sourceLayer)

const definition = (key: string, server: string): McpTool.Definition => ({
  key,
  server,
  name: key,
  description: key,
  maxLoadedTools: 4,
  unloadAfterIdleTurns: 3,
  inputSchema: { type: "object", properties: {} },
  call: () => Effect.succeed({ content: [{ type: "text", text: "ok" }] }),
})

describe("MCP tool source inventory", () => {
  sourceTest.effect("counts definitions by server and preserves empty server statuses", () =>
    Effect.gen(function* () {
      const source = yield* McpTool.Source
      const inventory = yield* source.inventory!({
        directory: "/tmp",
        definitions: Array.from({ length: 1024 }, (_, index) => definition(`tool-${index}`, `server-${index % 16}`)),
      })

      expect(inventory.servers).toHaveLength(18)
      expect(inventory.servers.slice(0, 2)).toEqual([
        { id: "server-0", status: "connected", definitions: 64 },
        { id: "server-1", status: "connected", definitions: 64 },
      ])
      expect(inventory.servers.slice(-2)).toEqual([
        { id: "empty", status: "connected", definitions: 0 },
        { id: "failed", status: "failed", definitions: 0, detail: "MCP connection failed" },
      ])
      expect(inventory.capabilities).toHaveLength(1024)
      expect(inventory.capabilities[0]?.key).toBe("tool-0")
      expect(inventory.capabilities.at(-1)?.key).toBe("tool-1023")
      expect(inventory.exclusions).toEqual([
        { server: "empty", reason: "no-definitions" },
        { server: "failed", reason: "failed" },
      ])
    }),
  )
})
