import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { errorMessage } from "@/util/error"
import { enabledIntegrations, makeContext, type Integration } from "../registry"
import { ToolError, type IntegrationContext, type ToolDef } from "../types"

/**
 * "TurenOS Security" stdio MCP server. Spawned by the forge MCP client as a
 * local server (`forge security-mcp`); stdout carries JSON-RPC, so all
 * logging goes to stderr.
 *
 * Enabled integrations come from FORGE_SECURITY_INTEGRATIONS (comma-separated
 * ids; unset or "all" enables everything). Secrets come from
 * FORGE_SECURITY_* env vars (see registry.ts).
 */

export const SERVER_NAME = "forge-security"

/** Hard cap for a serialized tool result. Integrations should stay well under it. */
export const MAX_RESULT_BYTES = 50_000

const log = (message: string) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`)

interface ToolEntry {
  integration: Integration
  tool: ToolDef
  context: IntegrationContext
}

/** Serialize handler data to compact JSON, truncating oversized payloads with a note. */
export function serializeResult(data: unknown): string {
  const text = data === undefined ? "null" : JSON.stringify(data)
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text
  const envelope = (length: number) =>
    JSON.stringify({
      truncated: true,
      note: `output exceeded ${MAX_RESULT_BYTES} bytes and was truncated; narrow the query for complete results`,
      partial: text.slice(0, length),
    })
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(envelope(middle), "utf8") <= MAX_RESULT_BYTES) low = middle
    else high = middle - 1
  }
  return envelope(low)
}

function toolIndex(integrations: Integration[], env: Record<string, string | undefined>): Map<string, ToolEntry> {
  const index = new Map<string, ToolEntry>()
  for (const entry of integrations) {
    const context = makeContext(entry, env, process.cwd())
    for (const tool of entry.tools) {
      if (index.has(tool.name)) {
        log(`duplicate tool name "${tool.name}" from integration "${entry.id}"; skipping`)
        continue
      }
      index.set(tool.name, { integration: entry, tool, context })
    }
  }
  return index
}

function instructions(integrations: Integration[]): string {
  const lines = [
    "TurenOS Security: vulnerability intelligence and local security scanners.",
    "Tool results are compact JSON. Enabled integrations:",
    ...integrations.map((entry) => `- ${entry.id} (${entry.category}): ${entry.instructions ?? entry.description}`),
  ]
  return lines.join("\n")
}

function errorResult(message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: serializeResult({ error: message, ...extra }) }],
    isError: true,
  }
}

function redact(value: unknown, context: IntegrationContext): unknown {
  const secrets = Object.values(context.secrets)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  if (typeof value === "string")
    return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
  if (Array.isArray(value)) return value.map((item) => redact(item, context))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, context)]))
}

export function createServer(env: Record<string, string | undefined> = process.env): Server {
  const enabled = enabledIntegrations(env, (id) =>
    log(`unknown integration id "${id}" in FORGE_SECURITY_INTEGRATIONS; skipping`),
  )
  const integrations = enabled.filter((entry) => entry.tools.length > 0)
  const index = toolIndex(integrations, env)

  const server = new Server(
    { name: SERVER_NAME, version: InstallationVersion },
    { capabilities: { tools: {} }, instructions: instructions(integrations) },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...index.values()].map(
      (entry): Tool => ({
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
      }),
    ),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = index.get(request.params.name)
    if (!entry) return errorResult(`unknown tool: ${request.params.name}`)
    try {
      const progressToken = request.params._meta?.progressToken
      const data = await entry.tool.handler(request.params.arguments ?? {}, entry.context, {
        signal: extra.signal,
        progress: async (input) => {
          if (progressToken === undefined) return
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, ...input },
          })
        },
      })
      return { content: [{ type: "text" as const, text: serializeResult(data) }] }
    } catch (error) {
      if (error instanceof ToolError) {
        return errorResult(redact(error.message, entry.context) as string, {
          integration: entry.integration.id,
          ...(error.detail === undefined ? {} : { detail: redact(error.detail, entry.context) }),
        })
      }
      const message = redact(errorMessage(error), entry.context) as string
      log(`tool "${request.params.name}" crashed: ${message}`)
      return errorResult(`internal error in ${request.params.name}: ${message}`, {
        integration: entry.integration.id,
      })
    }
  })

  return server
}

/** How often the orphan watchdog re-reads our parent pid. */
const ORPHAN_POLL_MS = 2_000

/**
 * Resolve as soon as the client that spawned us is gone.
 *
 * A stdio MCP child has exactly one reason to exist: the client on the other
 * end of its pipes. The SDK's `StdioServerTransport` only subscribes to stdin
 * `data` and `error`, never to `end`/`close`, so a child whose parent died —
 * crash, force-quit, SIGKILL — keeps running forever, reparented to init. This
 * is the half of the fix that survives a parent SIGKILL, because it needs no
 * cooperation from the parent at all.
 *
 * Two independent signals, so no single failure mode can strand us:
 *  - stdin `end`/`close`: the pipe's write end went away. Fires immediately and
 *    works on every platform, including Windows.
 *  - `process.ppid` becoming 1: POSIX reparents orphans to init. This is the
 *    backstop for any runtime that swallows the EOF, and it is only trusted
 *    once the pid has actually *changed* from what we were started with, so a
 *    process legitimately launched by pid 1 (a container entrypoint, launchd)
 *    is never mistaken for an orphan.
 */
export function watchOrphaned(input?: {
  stdin?: NodeJS.ReadableStream
  ppid?: () => number
  intervalMs?: number
  platform?: string
}): { orphaned: Promise<string>; stop: () => void } {
  const stdin = input?.stdin ?? process.stdin
  const readParent = input?.ppid ?? (() => process.ppid)
  const platform = input?.platform ?? process.platform
  const startedUnder = readParent()
  let stop = () => {}
  const orphaned = new Promise<string>((resolve) => {
    const onEnd = () => resolve("stdin closed")
    const timer = setInterval(() => {
      if (platform === "win32") return
      const current = readParent()
      if (current === 1 && current !== startedUnder) resolve("parent exited")
    }, input?.intervalMs ?? ORPHAN_POLL_MS)
    timer.unref?.()
    stdin.on("end", onEnd)
    stdin.on("close", onEnd)
    stop = () => {
      clearInterval(timer)
      stdin.off?.("end", onEnd)
      stdin.off?.("close", onEnd)
    }
  })
  return { orphaned, stop }
}

/** Start the stdio server and resolve when the connection closes or we are orphaned. */
export async function runSecurityMcpServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  const server = createServer(env)
  const transport = new StdioServerTransport()
  const closed = new Promise<string>((resolve) => {
    server.onclose = () => resolve("connection closed")
  })
  const watch = watchOrphaned()
  await server.connect(transport)
  log("ready")
  const reason = await Promise.race([closed, watch.orphaned])
  watch.stop()
  log(`shutting down: ${reason}`)
  await server.close().catch(() => {})
}
