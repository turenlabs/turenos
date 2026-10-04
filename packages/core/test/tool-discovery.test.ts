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
import { LLM, Message, ToolCallPart } from "@turenlabs/llm"
import * as OpenAIResponses from "@turenlabs/llm/protocols/openai-responses"
import { Auth, LLMClient } from "@turenlabs/llm/route"
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
    begin: (input) => Effect.sync(() => ToolBroker.beginTurn(input.sessionID, input.capabilities, input.directory)),
    selected: (input) =>
      Effect.sync(() =>
        ToolBroker.selected(input.sessionID, input.capabilities, input.directory).map((capability) => capability.key),
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

const discoveryLayer = (authority?: SessionTaskV2.Authority) =>
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
      [SessionTaskV2.node, Layer.mock(SessionTaskV2.Service, { authority: () => Effect.succeed(authority) })],
      [HandoffTool.node, Layer.mock(HandoffTool.Service, { forExecution: () => Effect.succeed({}) })],
      [ShellJobTool.node, Layer.mock(ShellJobTool.Service, { forExecution: () => Effect.succeed({}) })],
      [SessionTerminal.node, Layer.mock(SessionTerminal.Service, { get: () => Effect.succeed(undefined) })],
    ],
  )

const it = testEffect(discoveryLayer())
const childAuthority = SessionTaskV2.Authority.make({
  parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  ancestorPermissionSets: [],
  childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  hardPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  writeRoots: [],
  commands: [],
})
const childIt = testEffect(discoveryLayer(childAuthority))
const specialistAuthority = SessionTaskV2.Authority.make({
  ...childAuthority,
  childPermissions: [
    ...childAuthority.childPermissions,
    { action: "fixture_yara", resource: "*", effect: "allow" },
    { action: McpTool.toolName(mcpCapability.server, mcpCapability.name), resource: "*", effect: "allow" },
  ],
})
const specialistIt = testEffect(discoveryLayer(specialistAuthority))
const ceilingIt = testEffect(
  discoveryLayer(
    SessionTaskV2.Authority.make({
      ...specialistAuthority,
      ancestorPermissionSets: [
        [
          { action: "fixture_yara", resource: "*", effect: "deny" },
          { action: McpTool.toolName(mcpCapability.server, mcpCapability.name), resource: "*", effect: "deny" },
        ],
      ],
    }),
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
  childIt.effect("limits child discovery and direct calls to basic tools despite catch-all permissions", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("basic-child")
      const tools = yield* Tools.Service
      yield* tools.register({
        read: fixtureInline,
        whiteboard_draw: Tool.withPermission(fixtureInline, "read"),
        automation_create: fixtureInline,
        browser_start: fixtureInline,
      })
      const result = yield* materialize(sessionID)
      const names = result.materialization.definitions.map((definition) => definition.name)
      expect(names).toContain("read")
      expect(names).not.toContain("fixture_inline")
      expect(result.snapshot.deferred.available).toEqual([])
      expect(result.snapshot.broker.capabilities).toEqual([])
      expect((yield* result.materialization.settle(call(sessionID, "read", {}))).result.type).not.toBe("error")

      for (const name of [
        "fixture_yara",
        "fixture_inline",
        "whiteboard_draw",
        "automation_create",
        "browser_start",
        McpTool.toolName(mcpCapability.server, mcpCapability.name),
      ]) {
        expect(
          (yield* result.materialization.settle(call(sessionID, name, {}, `call-blocked-${name}`))).result,
        ).toEqual({
          type: "error",
          value: `Unknown tool: ${name}`,
        })
      }
      const searched = yield* result.materialization.settle(
        call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" }, "call-child-search"),
      )
      expect(searched.result).toMatchObject({ type: "json", value: { available: 0, matches: [] } })
      const loaded = yield* result.materialization.settle(
        call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: ["fixture_yara", mcpCapability.key] }, "call-child-load"),
      )
      expect(loaded.result).toMatchObject({ type: "error", value: "Tool is not available: fixture_yara" })
      const after = yield* materialize(sessionID)
      expect(after.snapshot.deferred.loaded).toEqual([])
      expect(after.snapshot.broker.loaded).toEqual([])
    }),
  )

  specialistIt.effect("keeps explicitly granted child specialist tools discoverable and executable", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("specialist-child")
      const result = yield* materialize(sessionID)
      expect(result.materialization.definitions.map((definition) => definition.name)).toContain("fixture_yara")
      expect(result.snapshot.broker.capabilities.map((entry) => entry.key)).toContain(mcpCapability.key)
      expect((yield* result.materialization.settle(call(sessionID, "fixture_yara", {}))).result.type).not.toBe("error")
      const loaded = yield* result.materialization.settle(
        call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: [mcpCapability.key] }, "call-specialist-load"),
      )
      expect(loaded.result.type).not.toBe("error")
      const after = yield* materialize(sessionID)
      expect(
        (yield* after.materialization.settle(
          call(sessionID, McpTool.toolName(mcpCapability.server, mcpCapability.name), {}, "call-specialist-mcp"),
        )).result.type,
      ).not.toBe("error")
      expect(
        (yield* result.materialization.settle(call(sessionID, "fixture_inline", {}, "call-specialist-blocked"))).result,
      ).toEqual({ type: "error", value: "Unknown tool: fixture_inline" })
    }),
  )

  ceilingIt.effect("does not let specialist grants override an ancestor's tool denial", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("child-ceiling")
      const result = yield* materialize(sessionID)
      expect(result.snapshot.deferred.available).toEqual([])
      expect(result.snapshot.broker.capabilities).toEqual([])
      for (const name of ["fixture_yara", McpTool.toolName(mcpCapability.server, mcpCapability.name)]) {
        expect(
          (yield* result.materialization.settle(call(sessionID, name, {}, `call-ceiling-${name}`))).result,
        ).toEqual({ type: "error", value: `Unknown tool: ${name}` })
      }
    }),
  )

  childIt.effect("does not expose child specialist definitions through native tool search", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("child-native")
      const snapshots = yield* SessionToolSnapshot.Service
      const result = yield* snapshots.materialize({ sessionID, directory, model, agent, nativeToolSearch: true })
      const searched = yield* result.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" }))
      expect(searched.result).toMatchObject({ type: "json", value: { available: 0, matches: [], tools: [] } })
      expect(result.snapshot.deferred.available).toEqual([])
      expect(result.snapshot.broker.capabilities).toEqual([])
    }),
  )

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

  it.effect("keeps an idle deferred selection loaded: every unload rewrites the cached prefix", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup("idle")
      const before = yield* materialize(sessionID)
      yield* before.materialization.settle(call(sessionID, ToolBroker.LOAD_TOOL_NAME, { tools: ["fixture_yara"] }))
      // Untouched for far longer than the old three-turn budget, it is still advertised, so the tool list at
      // the front of the cached prefix does not change. Unloading would cost a full uncached re-read.
      for (let turn = 1; turn <= ToolBroker.MIN_UNLOAD_AFTER_IDLE_TURNS; turn++)
        expect(
          (yield* materialize(sessionID)).materialization.definitions.map((definition) => definition.name),
        ).toContain("fixture_yara")

      // Only once the floor is passed does it drop.
      expect(
        (yield* materialize(sessionID)).materialization.definitions.map((definition) => definition.name),
      ).not.toContain("fixture_yara")
    }),
  )

  it.effect("raises a capability's own shorter idle budget to the floor", () =>
    Effect.sync(() => {
      // Twenty catalog capabilities declare three idle turns. Each would otherwise unload, and rewrite the
      // cached prefix, three turns after its last use.
      const capability = { key: "short-budget", name: "short-budget", server: "forge", unloadAfterIdleTurns: 3 }
      const id = "ses_broker_floor"
      ToolBroker.clear(id)
      ToolBroker.beginTurn(id, [capability])
      ToolBroker.load(id, [capability], [capability.key])
      for (let turn = 1; turn <= ToolBroker.MIN_UNLOAD_AFTER_IDLE_TURNS; turn++)
        expect(ToolBroker.beginTurn(id, [capability])).toContain(capability.key)
      expect(ToolBroker.beginTurn(id, [capability])).not.toContain(capability.key)
      ToolBroker.clear(id)
    }),
  )

  describe("native tool search", () => {
    const mcpName = McpTool.toolName(mcpCapability.server, mcpCapability.name)
    const allowAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
    const materializeNative = (sessionID: SessionSchema.ID, permissions: PermissionV2.Ruleset = allowAll) =>
      Effect.gen(function* () {
        const snapshots = yield* SessionToolSnapshot.Service
        return yield* snapshots.materialize({
          sessionID,
          directory,
          model,
          agent,
          permissions,
          nativeToolSearch: true,
        })
      })
    const searchOutput = (settled: { readonly result: { readonly type: string; readonly value?: unknown } }) => {
      expect(settled.result.type).toBe("json")
      return settled.result.value as {
        tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>
        omitted?: ReadonlyArray<string>
        selected: ReadonlyArray<string>
      }
    }
    const names = (result: SessionToolSnapshot.Result) =>
      result.materialization.definitions.map((definition) => definition.name)

    it.effect("advertises one fixed list: tool_search without tool_load", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-list")
        const advertised = names(yield* materializeNative(sessionID))

        expect(advertised).toContain(ToolBroker.SEARCH_TOOL_NAME)
        expect(advertised).not.toContain(ToolBroker.LOAD_TOOL_NAME)
        expect(advertised).toContain("fixture_inline")
        expect(advertised).not.toContain("fixture_yara")
      }),
    )

    it.effect("returns the definitions of the tools it loads, built-in and MCP", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-definitions")
        const before = yield* materializeNative(sessionID)
        const output = searchOutput(
          yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" })),
        )

        const tools = new Map((output.tools ?? []).map((tool) => [tool.name, tool]))
        expect(tools.get("fixture_yara")).toMatchObject({ description: "Scan a file with the fixture YARA engine." })
        expect(tools.get(mcpName)).toMatchObject({
          description: "Look up a record on the fixture server.",
          inputSchema: { type: "object", properties: {} },
        })
        expect(output.selected).toEqual(expect.arrayContaining(["fixture_yara", mcpCapability.key]))
      }),
    )

    it.effect("never changes the advertised list when tools load", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-stable")
        const before = yield* materializeNative(sessionID)
        yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" }))

        const after = yield* materializeNative(sessionID)
        const third = yield* materializeNative(sessionID)

        // The loaded tools are recorded as selected, but the list the provider sees is byte-for-byte the same.
        expect(after.snapshot.deferred.loaded).toContain("fixture_yara")
        expect(after.snapshot.broker.loaded).toContain(mcpCapability.key)
        expect(names(after)).toEqual(names(before))
        expect(names(third)).toEqual(names(before))
      }),
    )

    it.effect("keeps loaded tools executable although they are not advertised", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-execute")
        const before = yield* materializeNative(sessionID)
        yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" }))

        const after = yield* materializeNative(sessionID)
        expect(names(after)).not.toContain(mcpName)
        const mcp = yield* after.materialization.settle(call(sessionID, mcpName, {}, "call-mcp"))
        const builtin = yield* after.materialization.settle(call(sessionID, "fixture_yara", {}, "call-yara"))

        expect(mcp.result.type).not.toBe("error")
        expect(builtin.result).toMatchObject({ type: "json", value: { report: "scanned" } })
      }),
    )

    it.effect("loads only as many tools as the limit allows", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-limit")
        const before = yield* materializeNative(sessionID)
        const output = searchOutput(
          yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "", limit: 1 })),
        )

        expect(output.tools).toHaveLength(1)
        const after = yield* materializeNative(sessionID)
        expect(after.snapshot.deferred.loaded.length + after.snapshot.broker.loaded.length).toBe(1)
      }),
    )

    it.effect("does not load or describe a tool the agent is not permitted to use", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-denied")
        const before = yield* materializeNative(sessionID, [
          ...allowAll,
          { action: "fixture_yara", resource: "*", effect: "deny" },
        ])
        const output = searchOutput(
          yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" })),
        )

        expect((output.tools ?? []).map((tool) => tool.name)).not.toContain("fixture_yara")
        const after = yield* materializeNative(sessionID)
        expect(after.snapshot.deferred.loaded).not.toContain("fixture_yara")
      }),
    )

    it.effect("produces a result the Responses protocol lowers into tool_search_output", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-wire")
        const before = yield* materializeNative(sessionID)
        const output = searchOutput(
          yield* before.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" })),
        )
        const searchDefinition = before.materialization.definitions.find(
          (definition) => definition.name === ToolBroker.SEARCH_TOOL_NAME,
        )!

        const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.request({
            model: OpenAIResponses.route
              .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
              .model({ id: "gpt-6-sol" }),
            providerOptions: { openai: { toolSearch: "client" } },
            tools: [searchDefinition],
            messages: [
              Message.user("find tools"),
              Message.assistant([ToolCallPart.make({ id: "call_s", name: "tool_search", input: { query: "" } })]),
              Message.tool({ id: "call_s", name: "tool_search", result: output }),
            ],
          }),
        )

        expect(prepared.body.tools).toMatchObject([{ type: "tool_search", execution: "client" }])
        expect(prepared.body.input.at(-1)).toMatchObject({
          type: "tool_search_output",
          call_id: "call_s",
          status: "completed",
          execution: "client",
          tools: expect.arrayContaining([
            expect.objectContaining({ type: "function", name: "fixture_yara", defer_loading: true }),
            expect.objectContaining({ type: "function", name: mcpName, defer_loading: true }),
          ]),
        })
      }),
    )

    it.effect("leaves the legacy pair untouched when native search is off", () =>
      Effect.gen(function* () {
        const sessionID = yield* setup("native-off")
        const result = yield* materialize(sessionID, allowAll)
        const output = searchOutput(
          yield* result.materialization.settle(call(sessionID, ToolBroker.SEARCH_TOOL_NAME, { query: "" })),
        )

        expect(result.materialization.definitions.map((definition) => definition.name)).toContain(
          ToolBroker.LOAD_TOOL_NAME,
        )
        expect(output.tools).toBeUndefined()
      }),
    )
  })

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
      if (searched.result.type === "json") expect(searched.result.value).toMatchObject({ available: 1 })

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
