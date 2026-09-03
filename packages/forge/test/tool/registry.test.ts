import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".forge")])),
})
const root = LayerNode.group([ToolRegistry.node, Agent.node])
const it = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [
      RuntimeFlags.node,
      RuntimeFlags.layer({ experimentalCodeMode: false, experimentalBackgroundSubagents: false }),
    ],
  ]),
)
const weatherTools = {
  weather_current: {
    def: {
      name: "current",
      description: "current weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    } as MCPToolDef,
    client: {} as MCP.McpTool["client"],
    server: "weather",
  },
}
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed(weatherTools),
        clients: () => Effect.succeed({ weather: {} as MCP.McpTool["client"] }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).not.toContain("task_status")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.openai,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
        mcpTools: weatherTools,
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.openai,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
        mcpTools: {},
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.openai,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )
})
