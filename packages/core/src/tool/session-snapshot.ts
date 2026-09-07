export * as SessionToolSnapshot from "./session-snapshot"

import type { ToolDefinition } from "@turenlabs/llm"
import { Context, Effect, Layer, Option } from "effect"
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
import { McpTool } from "./mcp"
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
  readonly advanceMcpTurn?: boolean
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
      const [subagentTools, handoffTools, terminalBinding, mcpDefinitions] = yield* Effect.all(
        [
          subagents.forExecution({
            sessionID: input.sessionID,
            control,
            model: input.model,
          }),
          handoff.forExecution({ control, model: input.model, taskOwned }),
          terminal.get(input.sessionID),
          source.list({ directory: input.directory }),
        ] as const,
        { concurrency: "unbounded" },
      )
      const terminalTools: Readonly<Record<string, Tool.AnyTool>> = terminalBinding?.shared
        ? { terminal: SessionTerminal.tool(terminal, permissions) }
        : {}
      const mcpExclusions: Exclusion[] = []
      const usableMcpDefinitions: McpTool.Definition[] = []
      const mcpNames = new Set([
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
        if (isDenied(name, permissionSets)) {
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
      const mcpSelectedKeys =
        input.advanceMcpTurn === false && source.selected
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
        advanceMcpTurn: input.advanceMcpTurn,
      })
      const sessionTools = {
        ...providerTools,
        ...(yield* shellJobs.forExecution({ sessionID: input.sessionID, control })),
        ...harnessTools,
        ...reviewTools,
        ...subagentTools,
        ...handoffTools,
        ...terminalTools,
      }
      const materialization = yield* registry.materialize({
        permissionSets,
        session: sessionTools,
        subagentPromptContext: { harnessSnapshot: harnessState?.snapshot ?? null },
      })
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
          if (visibleNames.has(name) || !isDenied(Tool.permission(tool, name), permissionSets)) return []
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
  if (name === McpTool.SEARCH_TOOL_NAME || name === McpTool.LOAD_TOOL_NAME) return "mcp-broker"
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
