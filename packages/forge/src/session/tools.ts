import { Agent } from "@/agent/agent"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { McpBroker } from "@/mcp/broker"
import { McpTool } from "@turenlabs/core/tool/mcp"
import { McpIntegration } from "@/mcp/integration"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const RESERVED_MCP_TOOL_NAMES = new Set(["mcp_search", "mcp_load", ...Object.values(MCP_RESOURCE_TOOLS)])
const MAX_MCP_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_MCP_ATTACHMENTS = 32
const SUPPORTED_MCP_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const source = yield* Effect.serviceOption(McpTool.Source)
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
  const visibleMcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
  const canonicalDefinitions = Option.isSome(source)
    ? yield* source.value.list({ directory: input.session.directory })
    : undefined
  const canonicalByKey = new Map(canonicalDefinitions?.map((definition) => [definition.key, definition]))
  const availableMcpTools = Object.fromEntries(
    Object.entries(visibleMcpTools).filter(
      ([key]) => !RESERVED_MCP_TOOL_NAMES.has(key) && (!canonicalDefinitions || canonicalByKey.has(key)),
    ),
  )
  const capabilities = Object.entries(availableMcpTools).map(([key, entry]): McpTool.Capability => {
    const definition = canonicalByKey.get(key)
    if (definition) return definition
    return McpBroker.capability({
      key,
      server: entry.server,
      name: entry.def.name,
      description: entry.def.description,
    })
  })
  const selectedKeys = new Set(
    Option.isSome(source)
      ? yield* source.value.begin({
          sessionID: input.session.id,
          directory: input.session.directory,
          capabilities,
        })
      : McpBroker.beginTurn(input.session.id, capabilities, input.session.directory),
  )
  const selectedMcpTools = Object.fromEntries(
    Object.entries(availableMcpTools)
      .filter(([key]) => selectedKeys.has(key))
      .map(([key, entry]) => {
        const capability = capabilities.find((item) => item.key === key)!
        return [key, { ...entry, def: { ...entry.def, description: capability.description } }]
      }),
  )

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
    mcpTools: selectedMcpTools,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                return Effect.gen(function* () {
                  const error = Cause.squash(cause)
                  const output = { error, message: error instanceof Error ? error.message : String(error) }
                  yield* plugin.trigger(
                    "tool.execute.error",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                    output,
                  )
                  return yield* Effect.fail(new Error(output.message, { cause: error }))
                })
              }),
            )
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const brokerTool = (
    name: "mcp_search" | "mcp_load",
    description: string,
    schema: Record<string, unknown>,
    execute: (args: Record<string, unknown>) => Effect.Effect<unknown, unknown>,
  ) =>
    tool({
      description,
      inputSchema: jsonSchema(ProviderTransform.schema(input.model, schema)),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const values = toRecord(args)
            const ctx = context(values, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: name, sessionID: ctx.sessionID, callID: options.toolCallId },
              { args: values },
            )
            const result = yield* execute(values)
            const output = { title: name, metadata: {}, output: JSON.stringify(result, null, 2) }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: name, sessionID: ctx.sessionID, callID: options.toolCallId, args: values },
              output,
            )
            if (options.abortSignal?.aborted) yield* input.processor.completeToolCall(options.toolCallId, output)
            return output
          }),
        )
      },
    })

  tools.mcp_search = brokerTool(
    "mcp_search",
    McpTool.SEARCH_TOOL_DESCRIPTION,
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words from the capability, server, or tool name." },
      },
      additionalProperties: false,
    },
    (args) =>
      Option.isSome(source)
        ? source.value.search({
            sessionID: input.session.id,
            directory: input.session.directory,
            capabilities,
            query: optionalString(args, "query"),
          })
        : Effect.succeed(
            McpBroker.search(input.session.id, capabilities, optionalString(args, "query"), input.session.directory),
          ),
  )
  tools.mcp_load = brokerTool(
    "mcp_load",
    `${McpTool.LOAD_TOOL_DESCRIPTION} At most ${McpBroker.GLOBAL_MAX_LOADED_TOOLS} tools may be loaded globally, with lower server-specific limits.`,
    {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: McpBroker.GLOBAL_MAX_LOADED_TOOLS,
          description: "Exact tool keys returned by mcp_search.",
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    (args) =>
      Option.isSome(source)
        ? source.value.load({
            sessionID: input.session.id,
            directory: input.session.directory,
            capabilities,
            tools: stringArray(args, "tools"),
          })
        : Effect.try({
            try: () =>
              McpBroker.load(input.session.id, capabilities, stringArray(args, "tools"), input.session.directory),
            catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
          }),
  )

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  if (flags.experimentalCodeMode) return tools

  for (const [key, entry] of Object.entries(selectedMcpTools)) {
    const configuration =
      entry.server === "onepassword" || !McpIntegration.definition(entry.server)
        ? undefined
        : yield* mcp.configuration(entry.server)
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout, (result) =>
      McpIntegration.redactMcpResult(entry.server, configuration, result),
    )
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({
              permission: McpIntegration.requiresConfirmation(entry.server) ? "dynamic_mcp" : key,
              metadata: {},
              patterns: ["*"],
              always: ["*"],
            })
            if (Option.isSome(source))
              yield* source.value.touch({
                sessionID: input.session.id,
                directory: input.session.directory,
                key,
              })
            else McpBroker.touch(input.session.id, key, input.session.directory)
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          let attachmentBytes = 0
          const addAttachment = (mime: string, data: string, filename?: string) => {
            const size = base64Size(data)
            if (!SUPPORTED_MCP_ATTACHMENT_MIMES.has(mime)) {
              textParts.push(
                `[MCP attachment omitted: ${mime} (${formatBytes(size)}) is not a supported attachment type]`,
              )
              return
            }
            if (
              size > MAX_MCP_ATTACHMENT_BYTES ||
              attachmentBytes + size > MAX_MCP_ATTACHMENT_BYTES ||
              attachments.length >= MAX_MCP_ATTACHMENTS
            ) {
              textParts.push(`[MCP attachment omitted: ${mime} (${formatBytes(size)}) exceeds the attachment budget]`)
              return
            }
            attachmentBytes += size
            attachments.push({
              type: "file",
              mime,
              url: `data:${mime};base64,${data}`,
              ...(filename ? { filename } : {}),
            })
          }
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              addAttachment(contentItem.mimeType, contentItem.data)
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                addAttachment(mime, resource.blob, resource.uri)
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function stringArray(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0 || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${key} must be a non-empty array of strings`)
  }
  return value
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

export function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
  let attachmentBytes = 0

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (
        size > MAX_MCP_ATTACHMENT_BYTES ||
        attachmentBytes + size > MAX_MCP_ATTACHMENT_BYTES ||
        attachments.length >= MAX_MCP_ATTACHMENTS
      ) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds the attachment budget]`,
        )
        continue
      }
      attachmentBytes += size
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
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

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
