export * as McpTool from "./mcp"

import { Context, Effect, JsonSchema, Layer, Schema } from "effect"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Wildcard } from "../util/wildcard"
import { SessionToolProvider } from "./session-provider"
import { ToolBroker } from "./broker"
import { Tool } from "./tool"

/**
 * Canonical registration for tools hosted by MCP servers.
 *
 * The MCP client, its child processes and its OAuth state deliberately do NOT live here.
 * Exactly one MCP service may exist per process — each instance spawns a child per
 * configured server, and duplicates are only discoverable once orphaned — so this module
 * owns the *translation* (listing to canonical tool, result to model output) and leaves
 * ownership of the connection to whoever supplies `Source`. That keeps one MCP service
 * and one tool registry while V1 and V2 coexist.
 *
 * `Source` is a global node on purpose. `buildLocationServiceMap` wraps every
 * Location-scoped layer in `Layer.fresh`, which builds with a private memo map, so a
 * Location-scoped source would construct a fresh MCP service per open directory.
 * Global nodes are hoisted out of that wrapper and built once. The Location scope is
 * carried as an explicit `directory` argument instead.
 */

/** A single tool as the hosting server advertises it, plus the means to invoke it. */
export interface Definition {
  /** Stable qualified key used by the session broker, before provider-name validation. */
  readonly key: string
  /** Server name as configured, unsanitized. */
  readonly server: string
  /** Tool name as the server advertises it, unsanitized. */
  readonly name: string
  readonly description?: string
  readonly maxLoadedTools: number
  readonly unloadAfterIdleTurns: number
  readonly confirmationRequired?: boolean
  /** JSON Schema straight from `tools/list`; never derived from an Effect Schema. */
  readonly inputSchema: JsonSchema.JsonSchema
  readonly call: (input: Record<string, unknown>) => Effect.Effect<CallResult, Tool.Failure>
}

export interface Capability {
  readonly key: string
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly maxLoadedTools: number
  readonly unloadAfterIdleTurns: number
}

export type ExclusionReasonCode =
  | "disabled"
  | "connecting"
  | "needs-auth"
  | "failed"
  | "no-definitions"
  | "permission-denied"
  | "manifest-allowlist-denied"
  | "provider-model-filter"
  | "idle-unloaded"
  | "invalid-name"
  | "name-collision"

export interface InventoryServer {
  readonly id: string
  readonly status: "connected" | "connecting" | "disabled" | "needs-auth" | "failed" | "unknown"
  readonly definitions: number
  readonly detail?: string
}

export interface Inventory {
  readonly observedAt: number
  readonly servers: ReadonlyArray<InventoryServer>
  readonly capabilities: ReadonlyArray<Capability>
  readonly exclusions: ReadonlyArray<{
    readonly id?: string
    readonly server?: string
    readonly reason: ExclusionReasonCode
    readonly detail?: string
  }>
}

export interface SearchResult {
  readonly matches: ReadonlyArray<Capability & { readonly selected: boolean }>
  readonly selected: ReadonlyArray<string>
  readonly available: number
}

export interface LoadResult {
  readonly loaded: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
  readonly message: string
}

/** The `tools/call` result, in MCP's own shape. */
export interface CallResult {
  readonly content?: ReadonlyArray<unknown>
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface Interface {
  readonly list: (input: { readonly directory: string }) => Effect.Effect<ReadonlyArray<Definition>>
  readonly inventory?: (input: {
    readonly directory: string
    readonly definitions?: ReadonlyArray<Definition>
  }) => Effect.Effect<Inventory>
  readonly begin: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly capabilities: ReadonlyArray<Capability>
  }) => Effect.Effect<ReadonlyArray<string>>
  readonly selected?: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly capabilities: ReadonlyArray<Capability>
  }) => Effect.Effect<ReadonlyArray<string>>
  readonly search: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly capabilities: ReadonlyArray<Capability>
    readonly query?: string
  }) => Effect.Effect<SearchResult>
  readonly load: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly capabilities: ReadonlyArray<Capability>
    readonly tools: ReadonlyArray<string>
  }) => Effect.Effect<LoadResult, Tool.Failure>
  readonly touch: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly key: string
  }) => Effect.Effect<void>
}

export class Source extends Context.Service<Source, Interface>()("@forge/v2/McpToolSource") {}

const mcpTools = new WeakSet<object>()

/**
 * No servers. Replaced by whoever owns the MCP connections; a Location graph built
 * without that replacement simply advertises no MCP tools rather than failing.
 */
export const sourceNode = makeGlobalNode({
  service: Source,
  layer: Layer.succeed(
    Source,
    Source.of({
      list: () => Effect.succeed([]),
      begin: () => Effect.succeed([]),
      selected: () => Effect.succeed([]),
      search: () => Effect.succeed({ matches: [], selected: [], available: 0 }),
      load: () => Effect.fail(new Tool.Failure({ message: "MCP broker is unavailable" })),
      touch: () => Effect.void,
    }),
  ),
  deps: [],
})

/** Mirrors the V1 registry so a permission rule written for one path matches the other. */
export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
export const toolName = (server: string, name: string) => sanitize(server) + "_" + sanitize(name)

const Content = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("file"),
    data: Schema.String,
    mime: Schema.String,
    name: Schema.optional(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("type"))

export const Output = Schema.Struct({ content: Schema.Array(Content) })
export type Output = typeof Output.Type

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENTS = 32
const SUPPORTED_ATTACHMENT_MIMES = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"])

const base64Size = (value: string) => {
  let length = 0
  let previous = ""
  let last = ""
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13 || code === 32) continue
    length += 1
    previous = last
    last = value.charAt(index)
  }
  const padding = last === "=" ? (previous === "=" ? 2 : 1) : 0
  return Math.max(0, Math.floor((length * 3) / 4) - padding)
}

const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

/** Text carried by a result, used for the error message MCP reports through `isError`. */
export function errorText(result: CallResult) {
  const text = (result.content ?? [])
    .flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .filter((item) => item.trim())
    .join("\n\n")
  return text || "MCP tool returned an error"
}

/**
 * Project MCP content blocks onto the two shapes the canonical tool output allows.
 *
 * Blocks a server may legitimately send that have no canonical equivalent — resource
 * links, embedded text resources, and anything added by a later spec revision — are
 * preserved as text rather than dropped, because dropping them silently loses the only
 * answer the model was given.
 */
export function toOutput(result: CallResult): Output {
  const blocks = result.content ?? []
  // A structured-only result is the documented shape for tools that declare an
  // `outputSchema`; without this the model would receive an empty tool result.
  if (blocks.length === 0 && result.structuredContent !== undefined && result.structuredContent !== null)
    return { content: [{ type: "text", text: stringify(result.structuredContent) }] }

  const content: Array<typeof Content.Type> = []
  let attachmentBytes = 0
  let attachments = 0
  for (const block of blocks) {
    if (!isRecord(block)) {
      content.push({ type: "text", text: stringify(block) })
      continue
    }
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text })
      continue
    }
    if (
      (block.type === "image" || block.type === "audio") &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      const size = base64Size(block.data)
      if (
        !SUPPORTED_ATTACHMENT_MIMES.has(block.mimeType) ||
        size > MAX_ATTACHMENT_BYTES ||
        attachmentBytes + size > MAX_ATTACHMENT_BYTES ||
        attachments >= MAX_ATTACHMENTS
      ) {
        content.push({ type: "text", text: `[MCP attachment omitted: ${block.mimeType}, ${formatBytes(size)}]` })
        continue
      }
      attachmentBytes += size
      attachments += 1
      content.push({ type: "file", data: block.data, mime: block.mimeType })
      continue
    }
    if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource
      const name = typeof resource.uri === "string" ? resource.uri : undefined
      if (typeof resource.text === "string") {
        content.push({ type: "text", text: name ? `${name}\n${resource.text}` : resource.text })
        continue
      }
      if (typeof resource.blob === "string") {
        const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream"
        const size = base64Size(resource.blob)
        if (
          !SUPPORTED_ATTACHMENT_MIMES.has(mime) ||
          size > MAX_ATTACHMENT_BYTES ||
          attachmentBytes + size > MAX_ATTACHMENT_BYTES ||
          attachments >= MAX_ATTACHMENTS
        ) {
          content.push({
            type: "text",
            text: `[MCP attachment omitted: ${mime}, ${formatBytes(size)}]`,
          })
          continue
        }
        attachmentBytes += size
        attachments += 1
        content.push({ type: "file", data: resource.blob, mime, ...(name ? { name } : {}) })
        continue
      }
    }
    content.push({ type: "text", text: stringify(block) })
  }
  return { content }
}

/**
 * Restate the advertised schema as an object contract.
 *
 * Servers are allowed to omit `properties`, and strict provider APIs reject a tool whose
 * parameters are not an explicit keyed object. Matches the V1 conversion so a tool that
 * works on one session path works identically on the other.
 */
export function toInputSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    additionalProperties: false,
  }
}

export function make(
  definition: Definition,
  permission: PermissionV2.Interface,
  onUse: (key: string) => Effect.Effect<void> = () => Effect.void,
) {
  const name = toolName(definition.server, definition.name)
  const tool = Tool.make({
    description: definition.description ?? "",
    // The remote contract is the only authority on these arguments, so decoding is a
    // passthrough and `inputJsonSchema` carries what the model is actually told.
    input: Schema.Unknown,
    inputJsonSchema: toInputSchema(definition.inputSchema),
    output: Output,
    toModelOutput: ({ output }) => output.content,
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* permission.assert({
          action: definition.confirmationRequired ? "dynamic_mcp" : name,
          resources: ["*"],
          save: ["*"],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        yield* onUse(definition.key)
        const result = yield* definition.call(isRecord(input) ? input : {})
        // MCP reports tool failure in-band rather than as a protocol error, including for
        // an unknown tool name, so this is the normal failure path and not an edge case.
        if (result.isError) return yield* new Tool.Failure({ message: errorText(result) })
        return toOutput(result)
      }).pipe(
        // Only expected typed errors are translated; interruption and defects pass through.
        Effect.mapError((error) => {
          if (error._tag === "LLM.ToolFailure") return error
          if (error._tag === "PermissionV2.CorrectedError") return new Tool.Failure({ message: error.feedback })
          if (error._tag === "PermissionV2.BlockedError")
            return new Tool.Failure({ message: `Permission denied for ${name}` })
          return new Tool.Failure({ message: `Session not found for ${name}` })
        }),
      ),
  })
  mcpTools.add(tool)
  return tool
}

export function isMcpTool(tool: Tool.AnyTool) {
  return mcpTools.has(tool)
}

export const SEARCH_TOOL_NAME = "mcp_search"
export const LOAD_TOOL_NAME = "mcp_load"
export const DISCOVERY_SYSTEM_PROMPT = `Connected MCP integrations are exposed through ${SEARCH_TOOL_NAME} and ${LOAD_TOOL_NAME} so their full schemas do not consume context until needed. When the user asks which MCP integrations, external integrations, or capabilities are currently available, you MUST call ${SEARCH_TOOL_NAME} in that turn; an empty query lists all current capabilities. Never reuse an earlier availability result because integrations can be enabled or disabled between turns. When a user asks about an external service, account, or integration and no direct tool is visible, you MUST call ${SEARCH_TOOL_NAME} before claiming that the integration or credentials are unavailable. If it returns a relevant capability, call ${LOAD_TOOL_NAME} with its exact key. The selected tool becomes available on the following model turn within the same user request; use it then to complete the request.`
export const SEARCH_TOOL_DESCRIPTION = `Search the live set of connected and approved MCP capabilities. Use an empty query whenever asked which MCPs or integrations are currently available, and do not reuse an earlier result. Use this before claiming that an external integration or its credentials are unavailable. Relevant tools can then be selected with ${LOAD_TOOL_NAME}.`
export const LOAD_TOOL_DESCRIPTION =
  "Load approved MCP tool keys for this session. Loaded tools appear on the next model turn within the same user request."

const BrokerCapability = Schema.Struct({
  key: Schema.String,
  server: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  maxLoadedTools: Schema.Int,
  unloadAfterIdleTurns: Schema.Int,
  selected: Schema.Boolean,
})
const SearchOutput = Schema.Struct({
  matches: Schema.Array(BrokerCapability),
  selected: Schema.Array(Schema.String),
  available: Schema.Int,
})
const LoadOutput = Schema.Struct({
  loaded: Schema.Array(Schema.String),
  selected: Schema.Array(Schema.String),
  message: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const source = yield* Source
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const providers = yield* SessionToolProvider.Service
    const sessionTools = new Map<
      string,
      {
        readonly source: Interface
        readonly definitions: ReadonlyArray<Definition>
        readonly permissions: string
        readonly selected: string
        readonly tools: Readonly<Record<string, Tool.AnyTool>>
      }
    >()

    yield* providers.add({
      tools: Effect.fn("McpTool.forSession")(function* (target) {
        if (target.directory !== location.directory || target.workspaceID !== location.workspaceID) return {}
        const sessionSource = target.mcpSource ?? source
        const sessionPermission = target.mcpPermission ?? permission
        const listed = target.mcpDefinitions ?? (yield* sessionSource.list({ directory: location.directory }))
        const definitions = new Map<string, Definition>()
        const names = new Set([
          SEARCH_TOOL_NAME,
          LOAD_TOOL_NAME,
          ToolBroker.SEARCH_TOOL_NAME,
          ToolBroker.LOAD_TOOL_NAME,
        ])
        for (const definition of listed) {
          const name = toolName(definition.server, definition.name)
          if (names.has(name)) {
            yield* Effect.logWarning("skipping MCP tool with a colliding name", {
              server: definition.server,
              tool: definition.name,
              name,
            })
            continue
          }
          const usable = yield* Tool.validateName(name).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (!usable) {
            yield* Effect.logWarning("skipping MCP tool with an unusable name", {
              server: definition.server,
              tool: definition.name,
              name,
            })
            continue
          }
          if (whollyDisabled(name, target.permissions ?? [])) continue
          names.add(name)
          definitions.set(definition.key, definition)
        }

        const capabilities = [...definitions.values()].map(
          (definition): Capability => ({
            key: definition.key,
            server: definition.server,
            name: definition.name,
            description: definition.description,
            maxLoadedTools: definition.maxLoadedTools,
            unloadAfterIdleTurns: definition.unloadAfterIdleTurns,
          }),
        )
        const selectedKeys =
          target.mcpSelectedKeys ??
          (target.advanceMcpTurn === false && sessionSource.selected
            ? yield* sessionSource.selected({
                sessionID: target.sessionID,
                directory: location.directory,
                capabilities,
              })
            : yield* sessionSource.begin({ sessionID: target.sessionID, directory: location.directory, capabilities }))
        const selected = new Set(selectedKeys)
        const listedDefinitions = [...definitions.values()]
        const permissionsKey = JSON.stringify(target.permissions ?? [])
        const selectedKey = [...selected].toSorted().join("\0")
        const cached = sessionTools.get(target.sessionID)
        if (
          cached?.source === sessionSource &&
          cached.permissions === permissionsKey &&
          cached.selected === selectedKey &&
          cached.definitions.length === listedDefinitions.length &&
          cached.definitions.every((definition, index) => definition === listedDefinitions[index])
        )
          return cached.tools
        const registrations: Record<string, Tool.AnyTool> = {
          [SEARCH_TOOL_NAME]: Tool.make({
            description: SEARCH_TOOL_DESCRIPTION,
            input: Schema.Struct({ query: Schema.optional(Schema.String) }),
            output: SearchOutput,
            execute: (input) =>
              sessionSource.search({
                sessionID: target.sessionID,
                directory: location.directory,
                capabilities,
                query: input.query,
              }),
          }),
          [LOAD_TOOL_NAME]: Tool.make({
            description: `${LOAD_TOOL_DESCRIPTION} At most 12 tools may be loaded globally, with lower server-specific limits.`,
            input: Schema.Struct({ tools: Schema.Array(Schema.String) }),
            output: LoadOutput,
            execute: (input) =>
              input.tools.length > 0
                ? sessionSource.load({
                    sessionID: target.sessionID,
                    directory: location.directory,
                    capabilities,
                    tools: input.tools,
                  })
                : Effect.fail(new Tool.Failure({ message: "tools must be a non-empty array" })),
          }),
        }
        for (const [key, definition] of definitions) {
          if (!selected.has(key)) continue
          registrations[toolName(definition.server, definition.name)] = make(
            definition,
            sessionPermission,
            (selectedKey) =>
              sessionSource.touch({ sessionID: target.sessionID, directory: location.directory, key: selectedKey }),
          )
        }
        sessionTools.set(target.sessionID, {
          source: sessionSource,
          definitions: listedDefinitions,
          permissions: permissionsKey,
          selected: selectedKey,
          tools: registrations,
        })
        if (sessionTools.size > 500) sessionTools.delete(sessionTools.keys().next().value!)
        return registrations
      }),
    })
  }),
)

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  name: "tool/mcp",
  layer,
  deps: [sourceNode, PermissionV2.node, Location.node, SessionToolProvider.node],
})
