import { describe, expect } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { ToolBroker } from "@turenlabs/core/tool/broker"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { SessionToolSnapshot } from "@turenlabs/core/tool/session-snapshot"
import { ShellJobTool } from "@turenlabs/core/tool/shell-job"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { TeamBoardTool } from "@turenlabs/core/tool/team-board"
import { Tool } from "@turenlabs/core/tool/tool"
import { HandoffTool } from "@turenlabs/core/tool/handoff"
import { SessionTerminal } from "@turenlabs/core/session/terminal"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AgentV2 } from "@turenlabs/core/agent"
import { McpEvent } from "@turenlabs/schema/mcp-event"
import { Effect, Layer, Schema } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

/**
 * Every payload below is transcribed verbatim from a real MCP session: an
 * `@modelcontextprotocol/sdk` server over stdio, listed and called by a real SDK client
 * on the 2025-11-25 revision the app ships. That is why `inputSchema` carries `$schema`
 * and `execution.taskSupport` — writing the shape we assume would hide exactly the
 * fields production has to survive.
 */
// `outputSchema` and `execution` are kept verbatim from the wire even though the bridge
// ignores them: a listing that carries unexpected fields is the normal case, not an edge.
type Listed = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
  readonly [extra: string]: unknown
}

const LISTED: ReadonlyArray<Listed> = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "ping",
    description: "Takes no arguments.",
    inputSchema: { type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "structured",
    description: "Returns structured content only.",
    inputSchema: {
      type: "object",
      properties: { n: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 } },
      required: ["n"],
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    outputSchema: {
      type: "object",
      properties: { doubled: { type: "number" } },
      required: ["doubled"],
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "picture",
    description: "Returns an image block.",
    inputSchema: { type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "broken",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" },
    execution: { taskSupport: "forbidden" },
  },
]

/** Real `tools/call` results, keyed by the tool that produced them. */
const RESULTS: Record<string, McpTool.CallResult> = {
  echo: { content: [{ type: "text", text: "echo: hi" }] },
  ping: { content: [{ type: "text", text: "pong" }] },
  structured: { content: [], structuredContent: { doubled: 42 } },
  picture: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
  broken: { content: [{ type: "text", text: "it broke" }], isError: true },
  // A call for a name the server does not know comes back in band, not as a throw.
  missing: { content: [{ type: "text", text: "MCP error -32602: Tool nope not found" }], isError: true },
}

const SERVER = "capture-fixture"
const sessionID = SessionV2.ID.make("ses_mcp_tool_test")
const directory = AbsolutePath.make("/project")

const calls: Array<{ name: string; args: Record<string, unknown> }> = []
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const define = (server: string, tool: Listed) =>
  ({
    key: McpTool.toolName(server, tool.name),
    server,
    name: tool.name,
    description: tool.description,
    maxLoadedTools: 12,
    unloadAfterIdleTurns: 3,
    inputSchema: tool.inputSchema,
    call: (args) =>
      Effect.sync(() => {
        calls.push({ name: tool.name, args })
        return RESULTS[tool.name] ?? RESULTS.missing!
      }),
  }) satisfies McpTool.Definition

/** Layers build before each test body runs, so the initial listing is set here. */
let listing: ReadonlyArray<McpTool.Definition> = LISTED.map((tool) => define(SERVER, tool))
let duringList: Effect.Effect<void> | undefined
const selected = new Map<string, Set<string>>()
let beginCalls = 0

const directories: string[] = []
const sourceService = McpTool.Source.of({
  list: (input) =>
    Effect.gen(function* () {
      directories.push(input.directory)
      const listed = listing
      const during = duringList
      duringList = undefined
      if (during) yield* during
      return listed
    }),
  begin: (input) =>
    Effect.sync(() => {
      beginCalls += 1
      return [...(selected.get(input.sessionID) ?? [])].filter((key) =>
        input.capabilities.some((item) => item.key === key),
      )
    }),
  selected: (input) =>
    Effect.sync(() =>
      [...(selected.get(input.sessionID) ?? [])].filter((key) => input.capabilities.some((item) => item.key === key)),
    ),
  search: (input) =>
    Effect.sync(() => ({
      matches: input.capabilities.map((item) => ({
        ...item,
        selected: selected.get(input.sessionID)?.has(item.key) ?? false,
      })),
      selected: [...(selected.get(input.sessionID) ?? [])],
      available: input.capabilities.length,
    })),
  load: (input) =>
    Effect.sync(() => {
      const current = selected.get(input.sessionID) ?? new Set<string>()
      const loaded = input.tools.filter((key) => !current.has(key))
      for (const key of input.tools) current.add(key)
      selected.set(input.sessionID, current)
      return { loaded, selected: [...current], message: "Loaded for next turn." }
    }),
  touch: () => Effect.void,
})
const source = Layer.succeed(McpTool.Source, sourceService)
let snapshotAuthority: SessionTaskV2.Authority | undefined
const coordinationTool = Tool.make({
  description: "Coordinate through the team board.",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  execute: () => Effect.succeed({}),
})

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionToolProvider.node,
      McpTool.node,
    ]),
    [
      [McpTool.sourceNode, source],
      [PermissionV2.node, permission],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const itSnapshot = testEffect(
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
      [
        SubagentTool.node,
        Layer.mock(SubagentTool.Service, {
          forExecution: () =>
            Effect.succeed({
              [TeamBoardTool.postName]: coordinationTool,
              [TeamBoardTool.readName]: coordinationTool,
            }),
        }),
      ],
      [
        SessionTaskV2.node,
        Layer.mock(SessionTaskV2.Service, { authority: () => Effect.sync(() => snapshotAuthority) }),
      ],
      [HandoffTool.node, Layer.mock(HandoffTool.Service, { forExecution: () => Effect.succeed({}) })],
      [ShellJobTool.node, Layer.mock(ShellJobTool.Service, { forExecution: () => Effect.succeed({}) })],
      [SessionTerminal.node, Layer.mock(SessionTerminal.Service, { get: () => Effect.succeed(undefined) })],
    ],
  ),
)

const itSplitSource = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionToolProvider.node,
      McpTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const call = (name: string, input: unknown, id = "call-mcp") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") })

const materialize = Effect.fnUntraced(function* (registry: ToolRegistry.Interface) {
  const providers = yield* SessionToolProvider.Service
  const session = yield* providers.forExecution({ sessionID, model, directory })
  return yield* registry.materialize({ session })
})

const toolDefinitions = (registry: ToolRegistry.Interface) =>
  materialize(registry).pipe(
    Effect.map((value) =>
      value.definitions.filter(
        (item) => item.name !== McpTool.SEARCH_TOOL_NAME && item.name !== McpTool.LOAD_TOOL_NAME,
      ),
    ),
  )

const executeTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  materialize(registry).pipe(
    Effect.flatMap((value) => value.settle(input)),
    Effect.map((value) => value.result),
  )

const reset = Effect.sync(() => {
  calls.length = 0
  assertions.length = 0
  deny = false
  duringList = undefined
  selected.set(sessionID, new Set(listing.map((item) => item.key)))
})

const resetUnloaded = Effect.sync(() => {
  calls.length = 0
  assertions.length = 0
  deny = false
  duringList = undefined
  snapshotAuthority = undefined
  selected.delete(sessionID)
  beginCalls = 0
})

describe("McpTool", () => {
  it.effect("requires integration discovery before declaring a connected service unavailable", () =>
    Effect.sync(() => {
      expect(McpTool.DISCOVERY_SYSTEM_PROMPT).toContain("MUST call mcp_search")
      expect(McpTool.DISCOVERY_SYSTEM_PROMPT).toContain("call mcp_load")
      expect(McpTool.DISCOVERY_SYSTEM_PROMPT).toContain("same user request")
      expect(McpTool.DISCOVERY_SYSTEM_PROMPT).toContain("empty query lists all current capabilities")
      expect(McpTool.DISCOVERY_SYSTEM_PROMPT).toContain("Never reuse an earlier availability result")
      expect(McpTool.SEARCH_TOOL_DESCRIPTION).toContain("before claiming")
      expect(McpTool.SEARCH_TOOL_DESCRIPTION).toContain("live set")
    }),
  )

  it.effect("advertises only broker tools until a selection is loaded for the next turn", () =>
    Effect.gen(function* () {
      yield* resetUnloaded
      const registry = yield* ToolRegistry.Service
      const before = yield* materialize(registry)

      expect(before.definitions.map((tool) => tool.name).toSorted()).toEqual([
        McpTool.LOAD_TOOL_NAME,
        McpTool.SEARCH_TOOL_NAME,
      ])
      expect(
        (yield* before.settle(call(McpTool.LOAD_TOOL_NAME, { tools: listing.map((item) => item.key) }))).result.type,
      ).not.toBe("error")
      const definitions = yield* toolDefinitions(registry)

      expect(definitions.map((tool) => tool.name).toSorted()).toEqual([
        "capture-fixture_broken",
        "capture-fixture_echo",
        "capture-fixture_picture",
        "capture-fixture_ping",
        "capture-fixture_structured",
      ])
      // The Location's directory selects the connections, and listing remains turn-demanded.
      expect(directories.at(-1)).toBe(directory)
    }),
  )

  itSplitSource.effect(
    "executes broker tools with the snapshot source instead of the provider registration source",
    () =>
      Effect.gen(function* () {
        yield* resetUnloaded
        const providers = yield* SessionToolProvider.Service
        const registry = yield* ToolRegistry.Service
        const target = {
          sessionID,
          model,
          directory,
          mcpDefinitions: listing,
          mcpSource: sourceService,
        }
        const before = yield* registry.materialize({ session: yield* providers.forExecution(target) })
        const search = yield* before.settle(call(McpTool.SEARCH_TOOL_NAME, {}))

        expect(search.result).toMatchObject({ type: "json", value: { available: listing.length } })
        expect(
          (yield* before.settle(call(McpTool.LOAD_TOOL_NAME, { tools: [listing[0]!.key] }, "load-split-source"))).result
            .type,
        ).not.toBe("error")
        const after = yield* registry.materialize({ session: yield* providers.forExecution(target) })
        expect(after.definitions.map((tool) => tool.name)).toContain("capture-fixture_echo")
      }),
  )

  itSplitSource.effect("reuses per-session MCP tools until selection or permissions change", () =>
    Effect.gen(function* () {
      yield* resetUnloaded
      const providers = yield* SessionToolProvider.Service
      const registry = yield* ToolRegistry.Service
      const target = { sessionID, model, directory, mcpDefinitions: listing, mcpSource: sourceService }
      const first = yield* providers.forExecution(target)
      const second = yield* providers.forExecution(target)
      expect(second[McpTool.SEARCH_TOOL_NAME]).toBe(first[McpTool.SEARCH_TOOL_NAME])

      const materialized = yield* registry.materialize({ session: first })
      yield* materialized.settle(call(McpTool.LOAD_TOOL_NAME, { tools: [listing[0]!.key] }, "load-cache-test"))
      const selected = yield* providers.forExecution(target)
      expect(selected[McpTool.SEARCH_TOOL_NAME]).not.toBe(first[McpTool.SEARCH_TOOL_NAME])
      expect(selected[McpTool.toolName(listing[0]!.server, listing[0]!.name)]).toBeDefined()

      const restricted = yield* providers.forExecution({
        ...target,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      })
      expect(restricted[McpTool.SEARCH_TOOL_NAME]).not.toBe(selected[McpTool.SEARCH_TOOL_NAME])
    }),
  )

  it.effect("advertises the server's own JSON Schema rather than deriving one", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      const echo = definitions.find((tool) => tool.name === "capture-fixture_echo")

      expect(echo?.description).toBe("Echo a message back.")
      expect(echo?.inputSchema).toEqual({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      })
      // A server may omit `properties`; strict provider APIs reject that, so it is restated.
      const ping = definitions.find((tool) => tool.name === "capture-fixture_ping")
      expect(ping?.inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false })
    }),
  )

  it.effect("forwards arguments verbatim and returns text content to the model", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("capture-fixture_echo", { message: "hi" }))).toEqual({
        type: "text",
        value: "echo: hi",
      })
      expect(calls).toEqual([{ name: "echo", args: { message: "hi" } }])
      expect(assertions).toMatchObject([{ sessionID, action: "capture-fixture_echo", resources: ["*"], save: ["*"] }])
    }),
  )

  it.effect("renders a structured-only result instead of returning nothing", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("capture-fixture_structured", { n: 21 }))).toEqual({
        type: "text",
        value: JSON.stringify({ doubled: 42 }),
      })
    }),
  )

  it.effect("carries an image block through as file content", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("capture-fixture_picture", {}))).toEqual({
        type: "content",
        value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" }],
      })
    }),
  )

  it.effect("omits MCP media larger than the 10 MB aggregate attachment budget", () =>
    Effect.sync(() => {
      const oversized = "A".repeat(Math.ceil(((10 * 1024 * 1024 + 1) * 4) / 3))
      expect(
        McpTool.toOutput({ content: [{ type: "image", data: oversized, mimeType: "image/png" }] }).content,
      ).toEqual([{ type: "text", text: "[MCP attachment omitted: image/png, 11 MB]" }])
    }),
  )

  it.effect("treats a MIME-less MCP resource blob as unsupported media instead of provider-visible base64 text", () =>
    Effect.sync(() => {
      expect(
        McpTool.toOutput({
          content: [{ type: "resource", resource: { uri: "file:///unknown.bin", blob: "QUJD" } }],
        }).content,
      ).toEqual([{ type: "text", text: "[MCP attachment omitted: application/octet-stream, 3 B]" }])
    }),
  )

  it.effect("surfaces an in-band MCP failure as a tool error carrying the server's text", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("capture-fixture_broken", {}))).toEqual({
        type: "error",
        value: "it broke",
      })
    }),
  )

  it.effect("does not call the server when permission is denied", () =>
    Effect.gen(function* () {
      yield* reset
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call("capture-fixture_echo", { message: "hi" }))).toEqual({
        type: "error",
        value: "Permission denied for capture-fixture_echo",
      })
      expect(calls).toEqual([])
    }),
  )

  it.live("re-lists on tools/list_changed and swaps the advertised set", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      expect((yield* toolDefinitions(registry)).length).toBe(5)

      listing = [define(SERVER, LISTED[1])]
      yield* events.publish(McpEvent.ToolsChanged, { server: SERVER })
      yield* Effect.sleep("50 millis")

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["capture-fixture_ping"])
      // The replacement generation is live, not merely advertised.
      expect(yield* executeTool(registry, call("capture-fixture_ping", {}))).toEqual({
        type: "text",
        value: "pong",
      })
      listing = LISTED.map((tool) => define(SERVER, tool))
    }),
  )

  it.live("does not miss a change published during the initial listing", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      listing = LISTED.map((tool) => define(SERVER, tool))
      duringList = Effect.sync(() => {
        listing = [define(SERVER, LISTED[1]!)]
      }).pipe(Effect.andThen(events.publish(McpEvent.ToolsChanged, { server: SERVER })), Effect.asVoid)

      yield* toolDefinitions(registry)
      yield* Effect.sleep("50 millis")

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["capture-fixture_ping"])
      listing = LISTED.map((tool) => define(SERVER, tool))
    }),
  )

  it.live("drops only the tools whose qualified name the registry cannot accept", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      listing = [
        // A leading digit and an over-long name both survive sanitizing and are both
        // rejected by the registry; the healthy server must keep its tool regardless.
        define("1password", { name: "read", inputSchema: { type: "object", properties: {} } }),
        define("verbose", { name: "x".repeat(64), inputSchema: { type: "object", properties: {} } }),
        define("healthy", { name: "read", inputSchema: { type: "object", properties: {} } }),
      ]
      selected.set(sessionID, new Set(listing.map((item) => item.key)))
      yield* events.publish(McpEvent.ToolsChanged, { server: "healthy" })
      yield* Effect.sleep("50 millis")

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["healthy_read"])
      listing = LISTED.map((tool) => define(SERVER, tool))
    }),
  )

  it.live("keeps the first of two tools whose names sanitize to the same string", () =>
    Effect.gen(function* () {
      yield* reset
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      listing = [
        define("a b", { name: "t", inputSchema: { type: "object", properties: {} } }),
        define("a_b", { name: "t", inputSchema: { type: "object", properties: {} } }),
      ]
      selected.set(sessionID, new Set(listing.map((item) => item.key)))
      yield* events.publish(McpEvent.ToolsChanged, { server: "a b" })
      yield* Effect.sleep("50 millis")

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["a_b_t"])
      listing = LISTED.map((tool) => define(SERVER, tool))
    }),
  )
})

describe("SessionToolSnapshot", () => {
  itSnapshot.effect("shares the V2 broker and loaded MCP definitions with the runner materialization", () =>
    Effect.gen(function* () {
      yield* resetUnloaded
      const snapshots = yield* SessionToolSnapshot.Service
      const before = yield* snapshots.materialize({
        sessionID,
        directory,
        model,
        agent: AgentV2.ID.make("build"),
      })

      expect(
        before.snapshot.visible
          .filter((tool) => tool.source === "mcp-broker")
          .map((tool) => tool.id)
          .toSorted(),
      ).toEqual([ToolBroker.LOAD_TOOL_NAME, ToolBroker.SEARCH_TOOL_NAME])
      expect(before.snapshot.visible.map((tool) => tool.id)).not.toContain("invalid")
      expect(before.snapshot.broker.capabilities.map((capability) => capability.key).toSorted()).toEqual(
        listing.map((item) => item.key).toSorted(),
      )
      expect(before.snapshot.broker.notLoaded.toSorted()).toEqual(listing.map((item) => item.key).toSorted())

      const loaded = yield* before.materialization.settle(call(McpTool.LOAD_TOOL_NAME, { tools: [listing[0]!.key] }))
      expect(loaded.result.type).not.toBe("error")

      const after = yield* snapshots.materialize({
        sessionID,
        directory,
        model,
        agent: AgentV2.ID.make("build"),
      })
      expect(after.materialization.definitions.map((tool) => tool.name)).toContain("capture-fixture_echo")
      expect(after.materialization.definitions.map((tool) => tool.name)).toContain(ToolBroker.SEARCH_TOOL_NAME)
      expect(after.materialization.definitions.map((tool) => tool.name)).toContain(ToolBroker.LOAD_TOOL_NAME)
      expect(after.snapshot.visible.map((tool) => tool.id)).toEqual(
        after.materialization.definitions.map((tool) => tool.name),
      )
      expect(after.snapshot.visible.find((tool) => tool.id === "capture-fixture_echo")?.source).toBe("mcp")
      expect(after.snapshot.broker.loaded).toEqual([listing[0]!.key])
      expect(
        after.snapshot.broker.capabilities.find((capability) => capability.key === listing[0]!.key)?.selected,
      ).toBe(true)

      const beforeDiagnostic = beginCalls
      yield* snapshots.materialize({
        sessionID,
        directory,
        model,
        agent: AgentV2.ID.make("build"),
        advanceMcpTurn: false,
      })
      expect(beginCalls).toBe(beforeDiagnostic)
    }),
  )

  itSnapshot.effect("keeps TurenOS-owned session tools ahead of colliding MCP names", () =>
    Effect.gen(function* () {
      const previous = listing
      listing = [define("harness", { name: "review_request", inputSchema: { type: "object", properties: {} } })]
      yield* resetUnloaded
      const snapshots = yield* SessionToolSnapshot.Service
      const snapshot = yield* snapshots.materialize({
        sessionID,
        directory,
        model,
        agent: AgentV2.ID.make("build"),
      })

      expect(snapshot.snapshot.visible.find((tool) => tool.id === "harness_review_request")?.source).toBe("session")
      expect(snapshot.snapshot.exclusions).toContainEqual({
        id: "harness_review_request",
        server: "harness",
        source: "mcp",
        reason: "name-collision",
      })
      listing = previous
    }),
  )

  itSnapshot.effect("hides a child board tool denied by captured parent authority", () =>
    Effect.gen(function* () {
      yield* resetUnloaded
      snapshotAuthority = SessionTaskV2.Authority.make({
        parentPermissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: TeamBoardTool.postName, resource: "*", effect: "deny" },
        ],
        ancestorPermissionSets: [],
        childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        hardPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        writeRoots: [],
        commands: [],
      })
      const snapshot = yield* (yield* SessionToolSnapshot.Service).materialize({
        sessionID,
        directory,
        model,
        agent: AgentV2.ID.make("explore"),
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        parentID: SessionV2.ID.make("ses_snapshot_parent"),
      })

      expect(snapshot.snapshot.visible.map((tool) => tool.id)).toContain(TeamBoardTool.readName)
      expect(snapshot.snapshot.visible.map((tool) => tool.id)).not.toContain(TeamBoardTool.postName)
      expect(snapshot.snapshot.exclusions).toContainEqual({
        id: TeamBoardTool.postName,
        source: "session",
        reason: "permission-denied",
      })
    }),
  )
})

/**
 * The property that keeps MCP from being spawned per open directory.
 *
 * `buildLocationServiceMap` wraps every Location-scoped layer in `Layer.fresh`, which
 * builds against a private memo map. A Location-scoped source would therefore be
 * constructed once per directory, and in production each construction owns a child
 * process per configured server. Being a global node is what makes it hoisted, built
 * once, and handed the directory as an argument instead.
 *
 * Building the graph must also not reach the source at all. A Location graph is built for
 * any location-scoped request — a file search, a pty — and in production the first listing
 * is what starts MCP, so it waits for the first tool materialization of a turn.
 */
let constructions = 0
const listedDirectories: string[] = []

const countingSource = Layer.effect(
  McpTool.Source,
  Effect.sync(() => {
    constructions += 1
    return McpTool.Source.of({
      list: (input) =>
        Effect.sync(() => {
          listedDirectories.push(input.directory)
          return []
        }),
      begin: () => Effect.succeed([]),
      search: () => Effect.succeed({ matches: [], selected: [], available: 0 }),
      load: () => Effect.succeed({ loaded: [], selected: [], message: "Loaded for next turn." }),
      touch: () => Effect.void,
    })
  }),
)

const itLocations = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionToolProvider.node, LocationServiceMap.node]),
    [[McpTool.sourceNode, countingSource]],
  ),
)

describe("McpTool source in the Location graph", () => {
  itLocations.live("is constructed once and asked per directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([first, second]) =>
        Effect.gen(function* () {
          constructions = 0
          listedDirectories.length = 0
          const locations = yield* LocationServiceMap.Service

          for (const directory of [first.path, second.path])
            yield* Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const providers = yield* SessionToolProvider.Service
              expect(listedDirectories).not.toContain(directory)
              const session = yield* providers.forExecution({
                sessionID,
                model,
                directory: AbsolutePath.make(directory),
              })
              yield* registry.materialize({ session })
              expect(listedDirectories).toContain(directory)
            }).pipe(
              Effect.scoped,
              Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
            )

          expect(constructions).toBe(1)
          expect(listedDirectories.toSorted()).toEqual([first.path, second.path].toSorted())
        }),
      ),
    ),
  )
})
