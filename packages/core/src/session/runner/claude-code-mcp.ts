import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { ToolContent, ToolDefinition, ToolResultValue } from "@turenlabs/llm"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { ClaudeCodeGuidance } from "../../claude-code-guidance"

const metadataKey = "forge/claude-code-mcp"
const bridges = new Map<string, Bridge>()
const REQUEST_LIMIT = 2 * 1024 * 1024
const ACTIVE_DRAIN_TIMEOUT = 5_000

interface Bridge {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly execute: (call: {
    readonly id: string
    readonly name: string
    readonly input: unknown
  }) => Effect.Effect<ToolResultValue, unknown>
}

export class BridgeError extends Error {
  override readonly name = "ClaudeCodeMcp.BridgeError"
}

export const register = Effect.fn("ClaudeCodeMcp.register")(function* (bridge: Bridge) {
  const token = randomUUID()
  bridges.set(token, bridge)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (bridges.get(token) === bridge) bridges.delete(token)
    }),
  )
  return token
})

export const requestMetadata = (token: string) => ({ [metadataKey]: token })

export const requestToken = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const value = metadata?.[metadataKey]
  return typeof value === "string" ? value : undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const parse = (value: Uint8Array) => {
  try {
    return record(JSON.parse(Buffer.from(value).toString("utf8")))
  } catch {
    return undefined
  }
}

export const serve = Effect.fn("ClaudeCodeMcp.serve")(function* (token: string) {
  const bridge = bridges.get(token)
  if (!bridge) return yield* Effect.fail(new BridgeError("Claude Code MCP bridge is unavailable"))
  const runtime = yield* Effect.tryPromise({
    try: () => import("./claude-code-mcp-runtime"),
    catch: (cause) => new BridgeError(`Failed to load MCP runtime: ${String(cause)}`),
  })
  const tools: ReturnType<typeof runtime.ToolSchema.parse>[] = []
  for (const definition of bridge.definitions) {
    // `outputSchema` is deliberately never sent. No direct provider path ships it
    // (every protocol lowers `inputSchema` only), and the CLI treats a missing
    // output schema as "unstructured result" — which these are. Forwarding it
    // roughly doubled the per-tool payload (~6-8KB per request) and was re-sent
    // on every internal CLI round trip for nothing.
    const parsed = runtime.ToolSchema.safeParse({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })
    if (parsed.success) {
      tools.push(parsed.data)
      continue
    }
    yield* Effect.logWarning("Claude Code MCP bridge cannot describe a tool; skipping it", {
      tool: definition.name,
      issues: parsed.error.message,
    })
  }
  const controller = new AbortController()
  const active = new Set<Promise<CallToolResult>>()
  const workflow = ClaudeCodeGuidance.workflowState()
  const subagents = tools.some((tool) => tool.name === "spawn_agent" || tool.name === "task")
  const available = new Set(tools.map((tool) => tool.name))
  const mcp = new runtime.Server({ name: "forge", version: "1" }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(runtime.ListToolsRequestSchema, () => ({ tools }))
  mcp.setRequestHandler(runtime.CallToolRequestSchema, (request, extra) => {
    if (!available.has(request.params.name))
      return {
        content: [{ type: "text" as const, text: `Unknown or unavailable TurenOS tool: ${request.params.name}` }],
        isError: true,
      }
    const running = Effect.runPromise(
      bridge
        .execute({
          id: `mcp_${createHash("sha256")
            .update(`${token}\0${String(extra.requestId)}`)
            .digest("hex")}`,
          name: request.params.name,
          input: request.params.arguments ?? {},
        })
        .pipe(Effect.map(toCallToolResult)),
      { signal: controller.signal },
    )
    active.add(running)
    return running.finally(() => active.delete(running))
  })
  const transport = new runtime.WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  })
  yield* Effect.tryPromise({
    try: () => mcp.connect(transport),
    catch: (cause) => new BridgeError(`Failed to start MCP transport: ${String(cause)}`),
  })
  const mcpPath = `/${token}`
  const hookPath = `${mcpPath}/workflow-hook`
  const http = createServer((request, response) => {
    if ((request.url !== mcpPath && request.url !== hookPath) || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end()
      return
    }
    void (async () => {
      const contentLength = Number(request.headers["content-length"] ?? 0)
      if (Number.isFinite(contentLength) && contentLength > REQUEST_LIMIT) {
        response.writeHead(413).end()
        return
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of request) {
        const value = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        bytes += value.byteLength
        if (bytes > REQUEST_LIMIT) {
          response.writeHead(413).end()
          request.destroy()
          return
        }
        chunks.push(value)
      }
      const body = chunks.length === 0 ? new Uint8Array() : Buffer.concat(chunks)
      if (request.url === hookPath) {
        const input = parse(body)
        const calls = Array.isArray(input?.tool_calls)
          ? input.tool_calls.flatMap((value) => {
              const call = record(value)
              if (!call || typeof call.tool_name !== "string") return []
              return [{ name: call.tool_name, input: record(call.tool_input) ?? {} }]
            })
          : []
        const reminder = ClaudeCodeGuidance.workflowReminder(workflow, calls, { subagents })
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify(
            reminder ? { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: reminder } } : {},
          ),
        )
        return
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
        else if (value !== undefined) headers.set(name, value)
      }
      const result = await transport.handleRequest(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers,
          body: body.length === 0 ? undefined : body,
        }),
      )
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(Buffer.from(await result.arrayBuffer()))
    })().catch((cause) => {
      if (!response.headersSent) response.writeHead(500).end(String(cause))
      else response.destroy(cause instanceof Error ? cause : new Error(String(cause)))
    })
  })
  const port = yield* Effect.callback<number, BridgeError>((resume) => {
    const failed = (cause: Error) => resume(Effect.fail(new BridgeError(`Failed to listen for MCP: ${cause.message}`)))
    http.once("error", failed)
    http.listen(0, "127.0.0.1", () => {
      http.off("error", failed)
      const address = http.address()
      if (!address || typeof address === "string") {
        resume(Effect.fail(new BridgeError("MCP listener did not report a TCP address")))
        return
      }
      resume(Effect.succeed(address.port))
    })
    return Effect.sync(() => http.close())
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      controller.abort()
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ACTIVE_DRAIN_TIMEOUT)
          timer.unref?.()
        }),
      ])
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
      await mcp.close().catch(() => undefined)
    }),
  )
  return {
    url: `http://127.0.0.1:${port}${mcpPath}`,
    hookUrl: `http://127.0.0.1:${port}${hookPath}`,
    authorization: `Bearer ${token}`,
    tools: tools.map((tool) => tool.name),
  }
})

function toCallToolResult(result: ToolResultValue): CallToolResult {
  if (result.type === "error") return { content: [{ type: "text", text: stringify(result.value) }], isError: true }
  if (result.type === "text") return { content: [{ type: "text", text: stringify(result.value) }] }
  if (result.type === "json") return { content: [{ type: "text", text: stringify(result.value) }] }
  return {
    content: result.value.map((item: ToolContent) =>
      item.type === "text"
        ? { type: "text" as const, text: item.text }
        : { type: "text" as const, text: `[file ${item.name ?? item.uri}] ${item.uri} (${item.mime})` },
    ),
  }
}

function stringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
