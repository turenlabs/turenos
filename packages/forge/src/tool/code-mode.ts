import * as Tool from "./tool"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Option, Schema } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@turenlabs/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { McpBroker } from "@/mcp/broker"
import { McpConfig } from "@/mcp/config"
import { McpAuth } from "@/mcp/auth"
import { McpIntegration } from "@/mcp/integration"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import * as Truncate from "./truncate"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to connected MCP tools."
const CODE_MODE_LIMITS = { timeoutMs: 120_000, maxToolCalls: 32, maxOutputBytes: 256 * 1024 } as const
const CODE_MODE_TRUNCATION = { maxBytes: 50 * 1024, maxLines: 2_000 } as const
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENTS = 32
const SUPPORTED_ATTACHMENT_MIMES = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"])

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
  truncated?: boolean
  outputPath?: string
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  tool: MCP.McpTool
  configuration?: McpConfig.Info
}

function groupByServer(
  mcpTools: Record<string, MCP.McpTool>,
  servers: readonly string[],
  configurations = new Map<string, McpConfig.Info | undefined>(),
): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const entry: CatalogEntry = {
      path: `${server}.${local}`,
      key,
      server,
      local,
      tool: mcpTools[key]!,
      configuration: configurations.get(server),
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function describeCatalog(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): string {
  return CodeMode.make({
    tools: toolTree(
      [...groupByServer(mcpTools, servers).values()].flat(),
      () => () => Effect.fail(toolError("Tool preview is not executable.")),
    ),
  }).instructions()
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(
  result: CallToolResult,
  collect: (mime: string, base64: string, bytes: number, filename?: string) => boolean,
): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (mime: string, base64: string, filename?: string) => {
    const bytes = base64Size(base64)
    if (!SUPPORTED_ATTACHMENT_MIMES.has(mime) || bytes > MAX_ATTACHMENT_BYTES) {
      text.push(`[MCP attachment omitted: ${mime}, ${formatBytes(bytes)}]`)
      return
    }
    if (!collect(mime, base64, bytes, filename)) {
      text.push("[MCP attachment omitted: code-mode attachment budget exceeded]")
      return
    }
    files += 1
    if (mime.startsWith("image/")) images += 1
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push(block.mimeType, block.data)
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push(mime, block.resource.blob, lastSegment(block.resource.uri))
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
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

function stringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, SandboxTool.Definition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry.tool.def.description ?? "",
      input: entry.tool.def.inputSchema as SandboxTool.JsonSchema,
      output: entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined,
      run: run(entry),
    })
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  entry: CatalogEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
  truncate: Truncate.Interface
  agent: Agent.Info
  directory: string
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({
      permission: McpIntegration.requiresConfirmation(input.entry.server) ? "dynamic_mcp" : input.entry.key,
      metadata: {},
      patterns: ["*"],
      always: ["*"],
    })
    McpBroker.touch(input.ctx.sessionID, input.entry.key, input.directory)
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    const called = yield* Effect.promise(async () => {
      const signal = AbortSignal.any([input.ctx.abort, AbortSignal.timeout(CODE_MODE_LIMITS.timeoutMs)])
      return input.entry.tool.client.callTool(
        { name: input.entry.tool.def.name, arguments: input.args },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal,
          timeout: input.entry.tool.timeout,
          maxTotalTimeout: Math.max((input.entry.tool.timeout ?? 0) * 10, 600_000),
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
    })
    // Stored OAuth tokens never appear in the entry's headers, but a hostile or
    // buggy server can reflect the bearer it received back into a tool result.
    const stored = yield* Effect.serviceOption(McpAuth.Service).pipe(
      Effect.andThen((service) =>
        Option.isSome(service) ? service.value.get(input.entry.server) : Effect.succeed(undefined),
      ),
    )
    const result = McpIntegration.redactMcpResult(
      input.entry.server,
      input.entry.configuration,
      called,
      McpAuth.secrets(stored),
    )
    if (result.isError) {
      const message =
        result.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .filter((text) => text.trim())
          .join("\n\n") || "MCP tool returned an error"
      const bounded = yield* input.truncate.output(message, CODE_MODE_TRUNCATION, input.agent)
      return yield* Effect.fail(new Error(bounded.content))
    }
    return result
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service
    const truncate = yield* Truncate.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const available = Permission.visibleTools(yield* mcp.tools(), ruleset)
        const capabilities = Object.entries(available).map(([key, entry]) =>
          McpBroker.capability({
            key,
            server: entry.server,
            name: entry.def.name,
            description: entry.def.description,
          }),
        )
        const selected = new Set(
          McpBroker.selected(ctx.sessionID, capabilities, session.directory).map((item) => item.key),
        )
        const mcpTools = Object.fromEntries(
          Object.entries(available)
            .filter(([key]) => selected.has(key))
            .map(([key, entry]) => {
              const capability = capabilities.find((item) => item.key === key)!
              return [key, { ...entry, def: { ...entry.def, description: capability.description } }]
            }),
        )
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const configurations = new Map(
          yield* Effect.forEach(
            [
              ...new Set(
                Object.values(mcpTools)
                  .map((entry) => entry.server)
                  .filter((server) => server !== "onepassword" && McpIntegration.definition(server) !== undefined),
              ),
            ],
            (server) => mcp.configuration(server).pipe(Effect.map((configuration) => [server, configuration] as const)),
          ),
        )
        const catalog = [...groupByServer(mcpTools, servers, configurations).values()].flat()

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        let attachmentBytes = 0
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        let childCalls = 0
        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          Effect.gen(function* () {
            childCalls += 1
            const result = yield* invokeChildTool({
              plugin,
              entry,
              args: (input ?? {}) as Record<string, unknown>,
              callID: `${ctx.callID ?? entry.key}/${childCalls}`,
              ctx,
              truncate,
              agent,
              directory: session.directory,
            })
            const projected = projectMcpResult(result, (mime, base64, bytes, filename) => {
              if (attachments.length >= MAX_ATTACHMENTS || attachmentBytes + bytes > MAX_ATTACHMENT_BYTES) return false
              attachmentBytes += bytes
              attachments.push({
                type: "file",
                mime,
                url: dataUrl(mime, base64),
                ...(filename ? { filename } : {}),
              })
              return true
            })
            const bounded = yield* truncate.output(stringify(projected), CODE_MODE_TRUNCATION, agent)
            if (!bounded.truncated) return projected
            return { truncated: true, preview: bounded.content, outputPath: bounded.outputPath }
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              const error = Cause.squash(cause)
              return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
            }),
          )

        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          limits: CODE_MODE_LIMITS,
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const cancelled = (): CodeMode.Result => ({
          ok: false,
          error: { kind: "ExecutionFailure", message: "Execution cancelled." },
          toolCalls: calls.map((call) => ({ name: call.tool })),
        })

        const result = yield* Effect.raceFirst(runtime.execute(params.code), abort.pipe(Effect.map(cancelled)))
        const logs = result.logs ?? []
        const withLogs = (text: string) => {
          if (logs.length === 0) return text
          return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
        }

        if (!result.ok) {
          if (ctx.abort.aborted) {
            return {
              title: CODE_MODE_TOOL,
              metadata: { toolCalls: calls, error: true },
              output: "Execution cancelled.",
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
          const bounded = yield* truncate.output(
            withLogs([result.error.message, ...hints].join("\n")),
            CODE_MODE_TRUNCATION,
            agent,
          )
          return yield* Effect.fail(new Error(bounded.content))
        }

        const bounded = yield* truncate.output(withLogs(stringify(result.value)), CODE_MODE_TRUNCATION, agent)

        return {
          title: CODE_MODE_TOOL,
          metadata: {
            toolCalls: calls,
            ...(result.truncated === true || bounded.truncated ? { truncated: true } : {}),
            ...(bounded.truncated ? { outputPath: bounded.outputPath } : {}),
          },
          output: bounded.content,
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)
