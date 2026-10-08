export * as SessionToolSnapshot from "./session-snapshot"

import type { ToolDefinition } from "@turenlabs/llm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { PluginV2 } from "../plugin"
import { AbsolutePath } from "../schema"
import { SessionExecutionControl } from "../session/execution-control"
import { SessionHarness } from "../session/harness"
import { SessionSchema } from "../session/schema"
import { SessionTaskV2 } from "../session/task"
import { SessionTerminal } from "../session/terminal"
import { HandoffTool } from "./handoff"
import { ToolBroker } from "./broker"
import { McpTool } from "./mcp"
import { NativeToolSearch } from "./native-tool-search"
import { SubagentTool } from "./subagent"
import { ShellJobTool } from "./shell-job"
import { ToolRegistry } from "./registry"
import { SessionToolProvider } from "./session-provider"
import { Tool } from "./tool"
import { Wildcard } from "../util/wildcard"
import { makeLocationNode } from "../effect/app-node"

export type ToolSource = "builtin" | "session" | "mcp" | "mcp-broker"

export type ExclusionReasonCode = McpTool.ExclusionReasonCode

export interface Exclusion {
  readonly id?: string
  readonly server?: string
  readonly source?: ToolSource
  readonly reason: ExclusionReasonCode
  readonly detail?: string
}

export interface VisibleTool {
  readonly id: string
  readonly description: string
  readonly source: ToolSource
  readonly parameters: ToolDefinition["inputSchema"]
}

export interface Snapshot {
  readonly sessionID: SessionSchema.ID
  readonly directory: AbsolutePath
  readonly providerID: ModelV2.Ref["providerID"]
  readonly modelID: ModelV2.Ref["id"]
  readonly agent: AgentV2.ID
  readonly generatedAt: number
  readonly observedAt: number
  readonly generation: number
  readonly operationID?: string
  readonly visible: ReadonlyArray<VisibleTool>
  readonly mcpServers: McpTool.Inventory["servers"]
  readonly broker: {
    readonly visible: ReadonlyArray<string>
    readonly capabilities: ReadonlyArray<McpTool.Capability & { readonly selected: boolean }>
    readonly loaded: ReadonlyArray<string>
    readonly notLoaded: ReadonlyArray<string>
  }
  readonly deferred: {
    readonly available: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly selected: boolean
    }>
    readonly loaded: ReadonlyArray<string>
  }
  readonly exclusions: ReadonlyArray<Exclusion>
}

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly directory: AbsolutePath
  readonly model: ModelV2.Ref
  readonly agent: AgentV2.ID
  readonly permissions?: PermissionV2.Ruleset
  readonly parentID?: SessionSchema.ID
  readonly taskOwned?: boolean
  readonly control?: SessionExecutionControl.Interface
  readonly harnessState?: SessionHarness.State
  readonly harnessSessionID?: SessionSchema.ID
  readonly operationID?: string
  /** Advances the deferred-tool broker turn clock; pass false for non-mutating diagnostics. */
  readonly advanceTurn?: boolean
  /** @deprecated Use `advanceTurn`; built-in and MCP deferral share one turn clock. */
  readonly advanceMcpTurn?: boolean
  /**
   * Native tool search (see `NativeToolSearch`): loaded tools stay executable but are never advertised, and
   * `tool_search` returns their definitions in its result. The advertised list then does not change when a tool
   * is loaded, so the cached prefix survives.
   */
  readonly nativeToolSearch?: boolean
  readonly deferral?: {
    /** Defaults to true. When false, deferred tools are advertised inline like any other. */
    readonly enabled?: boolean
    /** Pins the advertised deferred selection for this materialization without mutating broker state. */
    readonly selected?: ReadonlySet<string>
  }
}

export interface Result {
  readonly snapshot: Snapshot
  /** The exact registry materialization represented by `snapshot.visible`. */
  readonly materialization: ToolRegistry.Materialization
}

export interface Interface {
  readonly ready: () => Effect.Effect<void>
  readonly materialize: (input: Input) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionToolSnapshot") {}

const DiscoveryCapability = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  server: Schema.optional(Schema.String),
  selected: Schema.Boolean,
})
const DiscoverySearchOutput = Schema.Struct({
  matches: Schema.Array(DiscoveryCapability),
  selected: Schema.Array(Schema.String),
  available: Schema.Int,
  // Native tool search only: the definitions of the tools this search loaded, for the provider to inject at the
  // end of the context window, and the ones that matched but did not fit the output limit.
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Unknown })),
  ),
  omitted: Schema.optional(Schema.Array(Schema.String)),
})
const DiscoveryLoadOutput = Schema.Struct({
  loaded: Schema.Array(Schema.Struct({ key: Schema.String, source: Schema.String })),
  selected: Schema.Array(Schema.String),
  message: Schema.String,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const permissions = yield* PermissionV2.Service
    const providers = yield* SessionToolProvider.Service
    const registry = yield* ToolRegistry.Service
    const source = yield* McpTool.Source
    const subagents = yield* SubagentTool.Service
    const shellJobs = yield* ShellJobTool.Service
    const tasks = yield* SessionTaskV2.Service
    const handoff = yield* HandoffTool.Service
    const terminal = yield* SessionTerminal.Service
    const harness = yield* Effect.serviceOption(SessionHarness.Service)
    const plugins = yield* Effect.serviceOption(PluginV2.Service)
    let generation = 0

    const ready = Effect.fn("SessionToolSnapshot.ready")(function* () {
      if (Option.isNone(plugins)) return
      yield* Effect.all(
        [plugins.value.wait(PluginV2.ID.make("agent")), plugins.value.wait(PluginV2.ID.make("config-agent"))],
        { concurrency: "unbounded" },
      )
    })

    const materialize = Effect.fn("SessionToolSnapshot.materialize")(function* (input: Input) {
      if (input.directory !== location.directory) return yield* Effect.interrupt
      generation += 1
      const generatedAt = Date.now()
      const control = input.control ?? SessionExecutionControl.noop
      const taskOwned = input.taskOwned ?? input.parentID !== undefined
      const authority = yield* tasks.authority(input.sessionID)
      const toolPermissions = authority ? SubagentTool.toolPermissions(authority.childPermissions) : undefined
      const permissionSets = authority
        ? [
            authority.parentPermissions,
            ...authority.ancestorPermissionSets,
            authority.childPermissions,
            authority.hardPermissions,
          ]
        : [input.permissions ?? []]
      const harnessState =
        input.harnessState ??
        (Option.isSome(harness)
          ? yield* harness.value
              .peek(input.harnessSessionID ?? input.sessionID)
              .pipe(Effect.catchTag("SessionHarness.NotFoundError", () => Effect.succeed(undefined)))
          : undefined)
      // PluginInternal runs in a scoped fiber. Wait before snapshotting the
      // agent registry so a cold first turn cannot omit specialist tools.
      yield* ready()
      const harnessTools = SessionHarness.tools(harnessState?.snapshot ?? undefined, permissions)
      const reviewTools: Readonly<Record<string, Tool.AnyTool>> =
        Option.isSome(harness) && input.parentID === undefined
          ? {
              [SessionHarness.REVIEW_REQUEST_TOOL_NAME]: SessionHarness.reviewRequestTool(
                harness.value,
                input.sessionID,
              ),
            }
          : {}
      const [subagentTools, handoffTools, mcpDefinitions] = yield* Effect.all(
        [
          subagents.forExecution({
            sessionID: input.sessionID,
            control,
            model: input.model,
          }),
          handoff.forExecution({ control, model: input.model, taskOwned }),
          source.list({ directory: input.directory }),
        ] as const,
        { concurrency: "unbounded" },
      )
      // The shared terminal is always in the catalog — it self-provisions on first call,
      // like the browser tools, so the model knows the capability exists even while off.
      const terminalTools: Readonly<Record<string, Tool.AnyTool>> = {
        terminal: SessionTerminal.tool(terminal, permissions),
      }
      const mcpExclusions: Exclusion[] = []
      const usableMcpDefinitions: McpTool.Definition[] = []
      const mcpNames = new Set([
        ToolBroker.SEARCH_TOOL_NAME,
        ToolBroker.LOAD_TOOL_NAME,
        McpTool.SEARCH_TOOL_NAME,
        McpTool.LOAD_TOOL_NAME,
        ...Object.keys(harnessTools),
        ...Object.keys(reviewTools),
        ...Object.keys(subagentTools),
        ...Object.keys(handoffTools),
        ...Object.keys(terminalTools),
      ])
      for (const definition of mcpDefinitions) {
        const name = McpTool.toolName(definition.server, definition.name)
        if (mcpNames.has(name)) {
          mcpExclusions.push({
            id: name,
            server: definition.server,
            source: "mcp",
            reason: "name-collision",
          })
          continue
        }
        const usable = yield* Tool.validateName(name).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        if (!usable) {
          mcpExclusions.push({
            id: name,
            server: definition.server,
            source: "mcp",
            reason: "invalid-name",
          })
          continue
        }
        if (isDenied(name, [...permissionSets, ...(toolPermissions ? [toolPermissions] : [])])) {
          mcpExclusions.push({
            id: name,
            server: definition.server,
            source: "mcp",
            reason: "permission-denied",
          })
          continue
        }
        mcpNames.add(name)
        usableMcpDefinitions.push(definition)
      }
      const inventory = source.inventory
        ? yield* source.inventory({ directory: input.directory, definitions: usableMcpDefinitions })
        : inventoryFromDefinitions(usableMcpDefinitions)
      const advance = input.advanceTurn ?? input.advanceMcpTurn ?? true
      const mcpSelectedKeys =
        !advance && source.selected
          ? yield* source.selected({
              sessionID: input.sessionID,
              directory: input.directory,
              capabilities: inventory.capabilities,
            })
          : yield* source.begin({
              sessionID: input.sessionID,
              directory: input.directory,
              capabilities: inventory.capabilities,
            })
      const providerTools = yield* providers.forExecution({
        sessionID: input.sessionID,
        model: input.model,
        directory: input.directory,
        workspaceID: location.workspaceID,
        permissions: input.permissions,
        agent: input.agent,
        mcpDefinitions: usableMcpDefinitions,
        mcpSource: source,
        mcpPermission: permissions,
        mcpSelectedKeys,
        advanceMcpTurn: advance,
      })
      const sessionToolsBase = {
        ...providerTools,
        ...(yield* shellJobs.forExecution({ sessionID: input.sessionID, control })),
        ...harnessTools,
        ...reviewTools,
        ...subagentTools,
        ...handoffTools,
        ...terminalTools,
      }
      // The deferred catalog is owned by the registry's registration view, so it takes one
      // probe materialization to learn which built-ins are deferrable before the broker's
      // selection can decide what the real materialization advertises. Definition derivation
      // is cached per tool name, so the second pass is cheap.
      const deferredCandidates = (yield* registry.materialize({
        permissionSets,
        toolPermissions,
        session: sessionToolsBase,
      })).deferred
      const deferralEnabled = input.deferral?.enabled !== false && deferredCandidates.length > 0
      const builtinCapabilities = deferredCandidates.map(
        (candidate): ToolBroker.Capability => ({
          key: candidate.name,
          name: candidate.name,
          description: candidate.description,
          source: "builtin",
          server: ToolBroker.BUILTIN_SERVER,
        }),
      )
      // MCP and deferred built-in selections share the broker's process-global state map.
      // The built-in domain needs its own scope: beginTurn prunes selections absent from
      // the caller's capability list, so one shared scope would have each domain evict
      // the other on every materialization.
      const brokerScope = `builtin\u0000${input.directory}`
      // An explicit non-catch-all allow rule means the agent declared this tool part of its
      // own contract (e.g. specialist profiles), so it stays inline rather than deferred.
      const forceInline = new Set(
        deferralEnabled
          ? deferredCandidates
              .filter((candidate) =>
                [input.permissions, ...permissionSets].some((rules) =>
                  (rules ?? []).some(
                    (rule) =>
                      rule.effect === "allow" &&
                      !(rule.action === "*" && rule.resource === "*") &&
                      Wildcard.match(candidate.action, rule.action),
                  ),
                ),
              )
              .map((candidate) => candidate.name)
          : [],
      )
      const builtinSelected = new Set(
        !deferralEnabled
          ? []
          : input.deferral?.selected !== undefined
            ? input.deferral.selected
            : !advance
              ? ToolBroker.selected(input.sessionID, builtinCapabilities, brokerScope).map(
                  (capability) => capability.key,
                )
              : ToolBroker.beginTurn(input.sessionID, builtinCapabilities, brokerScope),
      )
      const inline = () =>
        new Set(
          deferralEnabled
            ? [
                ...(input.deferral?.selected ??
                  ToolBroker.selected(input.sessionID, builtinCapabilities, brokerScope).map(
                    (capability) => capability.key,
                  )),
                ...forceInline,
              ]
            : builtinCapabilities.map((capability) => capability.key),
        )
      const native = input.nativeToolSearch === true
      // Under native search nothing loaded is advertised, so the per-server and global caps that kept the
      // advertised list short have nothing to protect.
      const loadCapabilities = native
        ? inventory.capabilities.map((capability) => ({ ...capability, maxLoadedTools: NativeToolSearch.MAX_LOADED }))
        : inventory.capabilities
      const loadCap = native ? NativeToolSearch.MAX_LOADED : ToolBroker.BUILTIN_MAX_LOADED_TOOLS
      const loadKeys = (keys: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const builtinKeys = new Set(builtinCapabilities.map((capability) => capability.key))
          const mcpKeys = new Set(inventory.capabilities.map((capability) => capability.key))
          const builtin = keys.some((key) => builtinKeys.has(key))
            ? yield* Effect.try({
                try: () =>
                  ToolBroker.load(
                    input.sessionID,
                    builtinCapabilities,
                    keys.filter((key) => builtinKeys.has(key)),
                    brokerScope,
                    { globalCap: loadCap },
                  ),
                catch: (error) =>
                  new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
              })
            : undefined
          const mcp = keys.some((key) => mcpKeys.has(key))
            ? yield* source.load({
                sessionID: input.sessionID,
                directory: input.directory,
                capabilities: loadCapabilities,
                tools: keys.filter((key) => mcpKeys.has(key)),
              })
            : undefined
          return { builtin, mcp }
        })
      // Definitions for the tools a search is about to load, in the caller's ranking. A built-in is only
      // returned if it survives the registry's permission filtering; an MCP tool only if it is in `usable`.
      const definitionsFor = (matches: ReadonlyArray<{ readonly key: string; readonly source?: string }>) =>
        Effect.gen(function* () {
          const builtinKeys = new Set(
            matches.filter((match) => match.source !== "mcp").map((match) => match.key),
          )
          const builtinDefinitions =
            builtinKeys.size === 0
              ? []
              : (yield* registry.materialize({
                  permissionSets,
                  toolPermissions,
                  session: sessionToolsBase,
                  deferred: { selected: builtinKeys, forceInline },
                })).definitions.filter((definition) => builtinKeys.has(definition.name))
          const byBuiltin = new Map(builtinDefinitions.map((definition) => [definition.name, definition]))
          const byMcp = new Map(usableMcpDefinitions.map((definition) => [definition.key, definition]))
          return matches.flatMap((match) => {
            if (match.source !== "mcp") {
              const definition = byBuiltin.get(match.key)
              return definition
                ? [
                    {
                      key: match.key,
                      name: definition.name,
                      description: definition.description,
                      inputSchema: definition.inputSchema,
                    },
                  ]
                : []
            }
            const definition = byMcp.get(match.key)
            return definition
              ? [
                  {
                    key: match.key,
                    name: McpTool.toolName(definition.server, definition.name),
                    description: definition.description ?? "",
                    inputSchema: definition.inputSchema,
                  },
                ]
              : []
          })
        })
      const discover = (query: string | undefined) =>
        Effect.gen(function* () {
          const mcp = yield* source.search({
            sessionID: input.sessionID,
            directory: input.directory,
            capabilities: inventory.capabilities,
            query,
          })
          const builtin = ToolBroker.search(input.sessionID, builtinCapabilities, query, brokerScope)
          const loaded = inline()
          return {
            matches: [
              ...builtin.matches.map((match) => ({ ...match, selected: loaded.has(match.key) })),
              ...mcp.matches.map((match) => ({ ...match, source: "mcp" as const })),
            ],
            selected: [...loaded, ...mcp.selected].toSorted(),
            available: builtin.available + mcp.available,
          }
        })
      const legacySearch = Tool.make({
        description: ToolBroker.SEARCH_TOOL_DESCRIPTION,
        input: Schema.Struct({ query: Schema.optional(Schema.String) }),
        output: DiscoverySearchOutput,
        execute: (args) => discover(args.query),
      })
      // Native: return the definitions of the best matches and load exactly those, so everything the model is
      // told about is callable and nothing it was not told about is loaded.
      const nativeSearch = Tool.make({
        description: NativeToolSearch.DESCRIPTION,
        input: Schema.Struct({ query: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
        output: DiscoverySearchOutput,
        execute: (args) =>
          Effect.gen(function* () {
            const base = yield* discover(args.query)
            const limit = Math.min(
              NativeToolSearch.MAX_LIMIT,
              Math.max(1, Math.floor(args.limit ?? NativeToolSearch.DEFAULT_LIMIT)),
            )
            const candidates = yield* definitionsFor(base.matches.slice(0, limit))
            const { included, omitted } = NativeToolSearch.fit(base, candidates)
            if (included.length > 0) yield* loadKeys(included.map((definition) => definition.key))
            return {
              ...base,
              selected: [...new Set([...base.selected, ...included.map((definition) => definition.key)])].toSorted(),
              tools: included.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
              ...(omitted.length === 0 ? {} : { omitted: omitted.map((definition) => definition.name) }),
            }
          }),
      })
      const sessionTools = {
        ...sessionToolsBase,
        [ToolBroker.SEARCH_TOOL_NAME]: native ? nativeSearch : legacySearch,
        [ToolBroker.LOAD_TOOL_NAME]: Tool.make({
          description: ToolBroker.LOAD_TOOL_DESCRIPTION,
          input: Schema.Struct({ tools: Schema.Array(Schema.String) }),
          output: DiscoveryLoadOutput,
          execute: (args) =>
            Effect.gen(function* () {
              if (args.tools.length === 0)
                return yield* new Tool.Failure({ message: "tools must be a non-empty array" })
              const builtinKeys = new Set(builtinCapabilities.map((capability) => capability.key))
              const mcpKeys = new Set(inventory.capabilities.map((capability) => capability.key))
              const unknown = args.tools.find((key) => !builtinKeys.has(key) && !mcpKeys.has(key))
              if (unknown) return yield* new Tool.Failure({ message: `Tool is not available: ${unknown}` })
              const { builtin, mcp } = yield* loadKeys(args.tools)
              const loaded = [
                ...(builtin?.loaded ?? []).map((key) => ({ key, source: "builtin" as const })),
                ...(mcp?.loaded ?? []).map((key) => ({ key, source: "mcp" as const })),
              ]
              return {
                loaded,
                selected: [...(builtin?.selected ?? []), ...(mcp?.selected ?? [])].toSorted(),
                message:
                  loaded.length === 0
                    ? "Those tools are already loaded."
                    : `Loaded ${loaded.map((item) => item.key).join(", ")}. The tools will be available on the next model turn.`,
              }
            }),
        }),
      }
      const materialized = yield* registry.materialize({
        permissionSets,
        toolPermissions,
        session: sessionTools,
        deferred: deferralEnabled ? { selected: builtinSelected, forceInline } : undefined,
        subagentPromptContext: { harnessSnapshot: harnessState?.snapshot ?? null },
      })
      // `mcp_search`/`mcp_load` remain settleable as hidden aliases for the MCP subset; the
      // unified `tool_search`/`tool_load` pair is what the model sees.
      // Native: `tool_load` is not needed (search loads what it returns), and loaded tools stay executable but are
      // never advertised, so the advertised list is the same on every turn. Tools an agent declared inline stay
      // advertised: that is part of its contract, not a selection.
      const hiddenAliases = new Set([
        McpTool.SEARCH_TOOL_NAME,
        McpTool.LOAD_TOOL_NAME,
        ...(native ? [ToolBroker.LOAD_TOOL_NAME] : []),
      ])
      const mcpSelected = new Set(mcpSelectedKeys)
      const nativeLoaded = native
        ? new Set([
            ...[...builtinSelected].filter((name) => !forceInline.has(name)),
            ...inventory.capabilities
              .filter((capability) => mcpSelected.has(capability.key))
              .map((capability) => McpTool.toolName(capability.server, capability.name)),
          ])
        : new Set<string>()
      const deferredNames = new Set(deferredCandidates.map((candidate) => candidate.name))
      const materialization: ToolRegistry.Materialization = {
        ...materialized,
        definitions: materialized.definitions.filter(
          (definition) => !hiddenAliases.has(definition.name) && !nativeLoaded.has(definition.name),
        ),
        settle: (executeInput) => {
          const name = executeInput.call.name
          if (deferralEnabled && input.deferral?.selected === undefined && deferredNames.has(name)) {
            if (!inline().has(name)) {
              try {
                ToolBroker.load(input.sessionID, builtinCapabilities, [name], brokerScope, {
                  globalCap: ToolBroker.BUILTIN_MAX_LOADED_TOOLS,
                })
              } catch {
                // A cap-exceeded or raced-out candidate still executes; it just stays unadvertised.
              }
            }
            ToolBroker.touch(input.sessionID, name, brokerScope)
          }
          return materialized.settle(executeInput)
        },
      }
      const searched = yield* source.search({
        sessionID: input.sessionID,
        directory: input.directory,
        capabilities: inventory.capabilities,
        query: "",
      })
      const selected = new Set(searched.selected)
      const visibleNames = new Set(materialization.definitions.map((definition) => definition.name))
      const definitionsByName = new Map(Object.entries(sessionTools))
      const exclusions = [
        ...mcpExclusions,
        ...inventory.exclusions,
        ...Object.entries(sessionTools).flatMap(([name, tool]) => {
          if (
            visibleNames.has(name) ||
            (!isDenied(Tool.permission(tool, name), permissionSets) &&
              !isDenied(name, toolPermissions ? [toolPermissions] : []))
          )
            return []
          return [
            {
              id: name,
              source: sourceFor(name, tool, inventory.capabilities),
              reason: "permission-denied" as const,
            },
          ]
        }),
        ...inventory.capabilities.flatMap((capability) => {
          const name = McpTool.toolName(capability.server, capability.name)
          if (!selected.has(capability.key) || visibleNames.has(name)) return []
          return [
            {
              id: name,
              server: capability.server,
              source: "mcp" as const,
              reason: "permission-denied" as const,
            },
          ]
        }),
      ]
      const visible = materialization.definitions.map((definition) => ({
        id: definition.name,
        description: definition.description,
        source: sourceFor(definition.name, definitionsByName.get(definition.name), inventory.capabilities),
        parameters: definition.inputSchema,
      }))
      const capabilities = inventory.capabilities.map((capability) => ({
        ...capability,
        selected: selected.has(capability.key),
      }))
      const snapshot: Snapshot = {
        sessionID: input.sessionID,
        directory: input.directory,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: input.agent,
        generatedAt,
        observedAt: inventory.observedAt,
        generation,
        ...(input.operationID ? { operationID: input.operationID } : {}),
        visible,
        mcpServers: inventory.servers,
        broker: {
          visible: visible.filter((tool) => tool.source === "mcp-broker").map((tool) => tool.id),
          capabilities,
          loaded: capabilities.filter((capability) => capability.selected).map((capability) => capability.key),
          notLoaded: capabilities.filter((capability) => !capability.selected).map((capability) => capability.key),
        },
        deferred: {
          available: materialization.deferred.map(({ name, description, selected }) => ({
            name,
            description,
            selected,
          })),
          loaded: materialization.deferred.filter((candidate) => candidate.selected).map((candidate) => candidate.name),
        },
        exclusions,
      }
      yield* Effect.logInfo("V2 session tool snapshot materialized", {
        sessionID: input.sessionID,
        directory: input.directory,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: input.agent,
        generation,
        visibleToolIDs: visible.map((tool) => tool.id),
        mcpCapabilityCount: capabilities.length,
        mcpSelectedCount: capabilities.filter((capability) => capability.selected).length,
        mcpCapabilityStatuses: inventory.servers.map((server) => `${server.id}=${server.status}`),
        exclusionCount: exclusions.length,
        exclusionReasons: Object.fromEntries(
          Object.entries(Object.groupBy(exclusions, (exclusion) => exclusion.reason)).map(([reason, values]) => [
            reason,
            values?.length ?? 0,
          ]),
        ),
      })
      return { snapshot, materialization }
    })

    return Service.of({ ready, materialize })
  }),
)

function sourceFor(
  name: string,
  tool: Tool.AnyTool | undefined,
  capabilities: ReadonlyArray<McpTool.Capability>,
): ToolSource {
  if (
    name === ToolBroker.SEARCH_TOOL_NAME ||
    name === ToolBroker.LOAD_TOOL_NAME ||
    name === McpTool.SEARCH_TOOL_NAME ||
    name === McpTool.LOAD_TOOL_NAME
  )
    return "mcp-broker"
  if (tool) return McpTool.isMcpTool(tool) ? "mcp" : "session"
  if (capabilities.some((capability) => McpTool.toolName(capability.server, capability.name) === name)) return "mcp"
  return "builtin"
}

function isDenied(action: string, permissionSets: ReadonlyArray<PermissionV2.Ruleset>) {
  return permissionSets.some((rules) => {
    const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
    return rule?.resource === "*" && rule.effect === "deny"
  })
}

function inventoryFromDefinitions(definitions: ReadonlyArray<McpTool.Definition>): McpTool.Inventory {
  return {
    observedAt: Date.now(),
    servers: [
      ...new Map(
        definitions.map((definition) => [
          definition.server,
          { id: definition.server, status: "connected" as const, definitions: 0 },
        ]),
      ).values(),
    ].map((server) => ({
      ...server,
      definitions: definitions.filter((definition) => definition.server === server.id).length,
    })),
    capabilities: definitions.map((definition) => ({
      key: definition.key,
      server: definition.server,
      name: definition.name,
      description: definition.description,
      maxLoadedTools: definition.maxLoadedTools,
      unloadAfterIdleTurns: definition.unloadAfterIdleTurns,
    })),
    exclusions: [],
  } satisfies McpTool.Inventory
}

export const node = makeLocationNode({
  name: "tool/session-snapshot",
  layer,
  deps: [
    Location.node,
    PermissionV2.node,
    ToolRegistry.node,
    SessionToolProvider.node,
    McpTool.sourceNode,
    SubagentTool.node,
    ShellJobTool.node,
    SessionTaskV2.node,
    HandoffTool.node,
    SessionTerminal.node,
    SessionHarness.node,
  ],
})
