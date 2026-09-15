import { describe, expect } from "bun:test"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTerminal } from "@turenlabs/core/session/terminal"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { ToolBroker } from "@turenlabs/core/tool/broker"
import { HandoffTool } from "@turenlabs/core/tool/handoff"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { SessionToolSnapshot } from "@turenlabs/core/tool/session-snapshot"
import { ShellJobTool } from "@turenlabs/core/tool/shell-job"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { Tool } from "@turenlabs/core/tool/tool"
import { Tools } from "@turenlabs/core/tool/tools"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const directory = AbsolutePath.make("/project")
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})
const agent = AgentV2.ID.make("build")

const fixtureYara = Tool.make({
  deferred: true,
  description: "Scan a file with the fixture YARA engine.",
  input: Schema.Struct({}),
  output: Schema.Struct({ report: Schema.String }),
  execute: () => Effect.succeed({ report: "scanned" }),
})
const fixtureInline = Tool.make({
  description: "Always advertised fixture tool.",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})

const mcpCapability = {
  key: "fixture-server_lookup",
  server: "fixture-server",
  name: "lookup",
  description: "Look up a record on the fixture server.",
  maxLoadedTools: 4,
  unloadAfterIdleTurns: 3,
} satisfies McpTool.Capability
// Mirrors the production McpToolSource: MCP selection is brokered through the same
// ToolBroker state map the snapshot uses for deferred built-ins, scoped by directory.
const source = Layer.succeed(
  McpTool.Source,
  McpTool.Source.of({
    list: () =>
      Effect.succeed([
        {
          ...mcpCapability,
          inputSchema: { type: "object", properties: {} },
          call: () => Effect.succeed({ content: [{ type: "text", text: "found" }] }),
        } satisfies McpTool.Definition,
      ]),
    begin: (input) =>
      Effect.sync(() => ToolBroker.beginTurn(input.sessionID, input.capabilities, input.directory)),
    selected: (input) =>
      Effect.sync(() =>
        ToolBroker.selected(input.sessionID, input.capabilities, input.directory).map(
          (capability) => capability.key,
        ),
      ),
    search: (input) =>
      Effect.sync(() => ToolBroker.search(input.sessionID, input.capabilities, input.query, input.directory)),
    load: (input) =>
      Effect.try({
        try: () => ToolBroker.load(input.sessionID, input.capabilities, input.tools, input.directory),
        catch: (error) => new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
      }),
    touch: (input) => Effect.sync(() => ToolBroker.touch(input.sessionID, input.key, input.directory)),
  }),
)

const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.void,
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionToolProvider.node,
      McpTool.node,
      SessionToolSnapshot.node,
    ]),
    [
      [McpTool.sourceNode, source],
      [PermissionV2.node, permission],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SubagentTool.node, Layer.mock(SubagentTool.Service, { forExecution: () => Effect.succeed({}) })],
      [SessionTaskV2.node, Layer.mock(SessionTaskV2.Service, { authority: () => Effect.succeed(undefined) })],
      [HandoffTool.node, Layer.mock(HandoffTool.Service, { forExecution: () => Effect.succeed({}) })],
      [ShellJobTool.node, Layer.mock(ShellJobTool.Service, { forExecution: () => Effect.succeed({}) })],
      [SessionTerminal.node, Layer.mock(SessionTerminal.Service, { get: () => Effect.succeed(undefined) })],
    ],
  ),
)

const call = (sessionID: SessionSchema.ID, name: string, input: unknown, id = "call-discovery") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const setup = Effect.fnUntraced(function* (suffix: string) {
  ToolBroker.clear()
  const tools = yield* Tools.Service
  yield* tools.register({ fixture_yara: fixtureYara, fixture_inline: fixtureInline })
  return SessionSchema.ID.make(`ses_tool_discovery_${suffix}`)
})

const materialize = (sessionID: SessionSchema.ID, permissions?: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const snapshots = yield* SessionToolSnapshot.Service
    return yield* snapshots.materialize({ sessionID, directory, model, agent, permissions })
  })

describe("SessionToolSnapshot tool discovery", () => {
  it.effect("withholds deferred built-ins from definitions while cataloging them", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("catalog")
      const result = yield* materialize(sessionID, [{ action: "*", resource: "*", effect: "allow" }])
      const names = result.materialization.definitions.map((definition) => definition.name)

      expect(names).toContain("fixture_inline")
      expect(names).toContain(ToolBroker.SEARCH_TOOL_NAME)
      expect(names).toContain(ToolBroker.LOAD_TOOL_NAME)
      expect(names).not.toContain("fixture_yara")
      expect(names).not.toContain(McpTool.SEARCH_TOOL_NAME)
      expect(names).not.toContain(McpTool.LOAD_TOOL_NAME)
      expect(result.materialization.deferred).toContainEqual({
        name: "fixture_yara",
        description: "Scan a file with the fixture YARA engine.",
        action: "fixture_yara",
        selected: false,
      })
      expect(result.snapshot.deferred.available.map((entry) => entry.name)).toContain("fixture_yara")
    }),
  )

  it.effect("advertises a deferred tool on the next turn after tool_load selects it", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("load")
      const before = yield* materialize(sessionID)
      const loaded = yield* before.materialization.settle(
        call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: ["fixture_yara"] }),
      )
      expect(loaded.result.type).not.toBe("error")

      const after = yield* materialize(sessionID)
      const names = after.materialization.definitions.map((definition) => definition.name)
      expect(names).toContain("fixture_yara")
      expect(after.materialization.deferred.find((entry) => entry.name === "fixture_yara")?.selected).toBe(true)
    }),
  )

  it.effect("keeps built-in and MCP selections alive while sharing the broker across turns", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("coexist")
      const first = yield* materialize(sessionID)
      const loaded = yield* first.materialization.settle(
        call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: ["fixture_yara", mcpCapability.key] }),
      )
      expect(loaded.result.type).not.toBe("error")

      // One beginTurn per domain runs on every materialization; a shared scope would have
      // each domain prune the other's selections, so neither tool would ever appear.
      const second = yield* materialize(sessionID)
      const names = second.materialization.definitions.map((definition) => definition.name)
      expect(names).toContain("fixture_yara")
      expect(names).toContain(McpTool.toolName(mcpCapability.server, mcpCapability.name))
      expect(second.snapshot.deferred.loaded).toContain("fixture_yara")
      expect(second.snapshot.broker.loaded).toContain(mcpCapability.key)

      const third = yield* materialize(sessionID)
      const later = third.materialization.definitions.map((definition) => definition.name)
      expect(later).toContain("fixture_yara")
      expect(later).toContain(McpTool.toolName(mcpCapability.server, mcpCapability.name))
    }),
  )

  it.effect("searches deferred built-ins by name and lists them on an empty query", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("search")
      const result = yield* materialize(sessionID)
      const searched = yield* result.materialization.settle(
        call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "yara" }),
      )
      expect(searched.result.type).toBe("json")
      expect(searched.result).toMatchObject({
        type: "json",
        value: {
          available: 2,
          matches: expect.arrayContaining([
            expect.objectContaining({ key: "fixture_yara", source: "builtin", selected: false }),
          ]),
        },
      })

      const all = yield* result.materialization.settle(
        call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" }, "call-discovery-empty"),
      )
      expect(all.result).toMatchObject({
        type: "json",
        value: {
          available: 2,
          matches: expect.arrayContaining([
            expect.objectContaining({ key: "fixture_yara", source: "builtin" }),
            expect.objectContaining({ key: mcpCapability.key }),
          ]),
        },
      })
    }),
  )

  it.effect("settles a direct call to a deferred tool and marks it loaded", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("direct")
      const before = yield* materialize(sessionID)
      expect(before.materialization.definitions.map((definition) => definition.name)).not.toContain("fixture_yara")

      const direct = yield* before.materialization.settle(call(sessionID, "fixture_yara", {}))
      expect(direct.result.type).not.toBe("error")

      const after = yield* materialize(sessionID)
      expect(after.materialization.definitions.map((definition) => definition.name)).toContain("fixture_yara")
    }),
  )

  it.effect("keeps a deferred tool inline when an explicit allow rule names it", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("force-inline")
      const result = yield* materialize(sessionID, [{ action: "fixture_yara", resource: "*", effect: "allow" }])

      expect(result.materialization.definitions.map((definition) => definition.name)).toContain("fixture_yara")
      expect(result.materialization.deferred.find((entry) => entry.name === "fixture_yara")?.selected).toBe(true)
    }),
  )

  it.effect("unloads a deferred selection left idle past its idle-turn budget", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("idle")
      const before = yield* materialize(sessionID)
      yield* before.materialization.settle(
        call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: ["fixture_yara"] }),
      )

      const advertised = yield* materialize(sessionID)
      expect(advertised.materialization.definitions.map((definition) => definition.name)).toContain("fixture_yara")

      // The default idle budget is three turns; the fourth untouched advance drops it.
      yield* materialize(sessionID)
      yield* materialize(sessionID)
      const last = yield* materialize(sessionID)
      expect(last.materialization.definitions.map((definition) => definition.name)).not.toContain("fixture_yara")
    }),
  )

  it.effect("keeps the hidden mcp_search and mcp_load aliases settleable", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("mcp-alias")
      const result = yield* materialize(sessionID)
      const names = result.materialization.definitions.map((definition) => definition.name)
      expect(names).not.toContain(McpTool.SEARCH_TOOL_NAME)
      expect(names).not.toContain(McpTool.LOAD_TOOL_NAME)
      expect(result.snapshot.broker.capabilities.map((capability) => capability.key)).toEqual([mcpCapability.key])

      const searched = yield* result.materialization.settle(call(sessionID, McpTool.SEARCH_TOOL_NAME, {}))
      expect(searched.result.type).toBe("json")
      if (searched.result.type === "json")
        expect(searched.result.value).toMatchObject({ available: 1 })

      const loaded = yield* result.materialization.settle(
        call(sessionID, McpTool.LOAD_TOOL_NAME, { tools: [mcpCapability.key] }, "call-mcp-load"),
      )
      expect(loaded.result.type).not.toBe("error")

      const after = yield* materialize(sessionID)
      expect(after.materialization.definitions.map((definition) => definition.name)).toContain(
        McpTool.toolName(mcpCapability.server, mcpCapability.name),
      )
      expect(after.snapshot.broker.loaded).toEqual([mcpCapability.key])
    }),
  )
})
