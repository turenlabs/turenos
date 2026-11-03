export * as AntigravityAcpBridge from "./antigravity-acp-bridge"

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Writable } from "node:stream"
import { isContextOverflow, LLMError, LLMEvent, LLMRequest, TransportReason } from "@turenlabs/llm"
import { Endpoint, Protocol, Route, type RouteDefaultsInput, type TransportDef } from "@turenlabs/llm/route"
import { Cause, Effect, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { ModelV2 } from "../../model"
import { AntigravityAcpCLI } from "../../provider/antigravity-acp"
import { ClaudeCodeMcp } from "./claude-code-mcp-namespace"

export const ROUTE_ID = "antigravity-acp-cli"
export const PROTOCOL_VERSION = 1

const TEXT_ID = "antigravity-text"
const REASONING_ID = "antigravity-reasoning"
const CHROMIUM_BROWSER_NOISE = "Opening in existing browser session."
const OMITTED = "[Earlier transcript omitted by TurenOS: it exceeded the prompt limit.]"
const PROMPT_LIMIT = 4 * 1024 * 1024
const LINE_LIMIT = 8 * 1024 * 1024
const OUTPUT_LIMIT = 32 * 1024 * 1024
const STDERR_LIMIT = 8 * 1024
const HANDSHAKE_TIMEOUT = 60_000

/**
 * Single-flight gate for all `agy_acp_server` subprocess launches in this process.
 *
 * `antigravity-acp` is a single-user personal OAuth client (`oauth-personal`) that reads and
 * refreshes shared credentials (`~/.gemini/antigravity-acp/acp_token.json` / OS keychain).
 * Serializing turns and interactive sign-in prevents concurrent subprocesses from racing on token
 * refresh or firing parallel request bursts when subagents, timers, or Factory rooms fan out.
 */
const turnGate = Semaphore.makeUnsafe(1)
const activeTurnTokens = new Set<string>()
export const withTurnPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) => turnGate.withPermits(1)(effect)
export const acquireTurnPermit = Effect.uninterruptibleMask((restore) =>
  restore(turnGate.take(1)).pipe(Effect.tap(() => Effect.addFinalizer(() => turnGate.release(1)))),
)

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const error = (message: string) =>
  new LLMError({
    module: "AntigravityAcpBridge",
    method: "stream",
    reason: new TransportReason({ message, kind: ROUTE_ID }),
  })

export function environment(
  directory: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const names = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "USERNAME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TZ",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]]))),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  }
  if (platform === "darwin" && env.AGY_ACP_FORCE_FILE_STORAGE === undefined) {
    const geminiHome = env.GEMINI_HOME || (env.HOME ? join(env.HOME, ".gemini") : undefined)
    if (geminiHome && existsSync(join(geminiHome, "antigravity-acp", "acp_token.json"))) {
      env.AGY_ACP_FORCE_FILE_STORAGE = "1"
    }
  }
  return env
}

export function args(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "linux" ? ["--uid="] : []
}

export type McpServerEntry = {
  readonly type: "http"
  readonly name: string
  readonly url: string
  readonly headers: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
}

export function mcpServers(mcp?: { url: string; authorization: string }): McpServerEntry[] {
  if (!mcp) return []
  return [
    {
      type: "http",
      name: "forge",
      url: mcp.url,
      headers: [
        {
          name: "Authorization",
          value: mcp.authorization,
        },
      ],
    },
  ]
}

function formatMessage(message: LLMRequest["messages"][number]): string {
  const body = message.content
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "reasoning") return `[reasoning]\n${part.text}`
      if (part.type === "tool-call") return `[tool call ${part.name}] ${JSON.stringify(part.input)}`
      if (part.type === "tool-result") {
        if (part.result.type !== "content") return `[tool result ${part.name}] ${JSON.stringify(part.result.value)}`
        const lines = ClaudeCodeMcp.toCallToolResult(part.result).content.flatMap((item) => {
          if (item.type === "text") return [item.text]
          if (item.type === "image") {
            return [`[image from ${part.name} omitted: Antigravity ACP bridge supports text only]`]
          }
          return []
        })
        return lines.length > 0 ? `[tool result ${part.name}]\n${lines.join("\n")}` : `[tool result ${part.name}]`
      }
      throw new Error("Antigravity ACP bridge currently supports text only")
    })
    .join("\n")
  return `${message.role.toUpperCase()}:\n${body}`
}

export function prompt(request: LLMRequest) {
  const systemParts = [
    "You are running inside TurenOS. TurenOS owns the session, permissions, workspace, tools, and conversation history.",
    ...(request.tools.length > 0
      ? [
          "Use only tools from the forge MCP server for work. Your local workspace is an empty transport directory, not the user's project.",
        ]
      : []),
    ...request.system.map((part) => part.text).filter((text) => text.trim().length > 0),
  ]
  const rendered = request.messages
    .filter((message) => record(message.metadata?.forge)?.internalContext !== "runtime")
    .map(formatMessage)
  const prefix = systemParts.join("\n\n")
  const transcript = rendered.join("\n\n") || "Continue."
  const full = `${prefix}\n\n${transcript}`
  if (Buffer.byteLength(full) <= PROMPT_LIMIT) return full

  for (let start = 1; start < rendered.length; start += 1) {
    const trimmed = `${prefix}\n\n${OMITTED}\n\n${rendered.slice(start).join("\n\n")}`
    if (Buffer.byteLength(trimmed) <= PROMPT_LIMIT) return trimmed
  }
  throw new Error("Antigravity ACP prompt exceeds the bridge's 4 MiB limit")
}

export type OutboundMessage = {
  readonly jsonrpc: "2.0"
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
}

export type AdapterInput = {
  readonly modelID: string
  readonly effort?: AntigravityAcpCLI.EffortLevel
  readonly cwd: string
  readonly mcp?: { url: string; authorization: string }
  readonly promptText: string
}

type QueuedRequest = {
  readonly method: string
  readonly params: Record<string, unknown>
}

export type AdapterState = {
  nextId: number
  phase: "init" | "authenticate" | "session_new" | "configure" | "prompt" | "done"
  pendingRequestId: number | string | undefined
  queuedRequests: QueuedRequest[]
  sessionId: string | undefined
  authenticationMethod: string | undefined
  authenticationAttempted: boolean
  readonly modelID: string
  readonly effort: AntigravityAcpCLI.EffortLevel | undefined
  readonly cwd: string
  readonly mcp: McpServerEntry[]
  readonly promptText: string
  textOpen: boolean
  reasoningOpen: boolean
  textId: string
  reasoningId: string
  textSeq: number
  reasoningSeq: number
  completed: boolean
}

export const adapterState = (input: AdapterInput): AdapterState => ({
  nextId: 1,
  phase: "init",
  pendingRequestId: undefined,
  queuedRequests: [],
  sessionId: undefined,
  authenticationMethod: undefined,
  authenticationAttempted: false,
  modelID: input.modelID,
  effort: input.effort,
  cwd: input.cwd,
  mcp: mcpServers(input.mcp),
  promptText: input.promptText,
  textOpen: false,
  reasoningOpen: false,
  textId: TEXT_ID,
  reasoningId: REASONING_ID,
  textSeq: 0,
  reasoningSeq: 0,
  completed: false,
})

function closeOpenSegments(state: AdapterState): LLMEvent[] {
  const events: LLMEvent[] = []
  if (state.reasoningOpen) {
    state.reasoningOpen = false
    events.push(LLMEvent.reasoningEnd({ id: state.reasoningId }))
  }
  if (state.textOpen) {
    state.textOpen = false
    events.push(LLMEvent.textEnd({ id: state.textId }))
  }
  return events
}

export function startHandshake(state: AdapterState): OutboundMessage {
  const id = state.nextId++
  state.phase = "init"
  state.pendingRequestId = id
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "turenos",
        title: "TurenOS",
        version: "1.0.0",
      },
    },
  }
}

export function cancelNotification(state: AdapterState): OutboundMessage | undefined {
  if (state.completed || !state.sessionId) return undefined
  return {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: {
      sessionId: state.sessionId,
    },
  }
}

export type StepOutcome =
  | {
      readonly ok: true
      readonly events: LLMEvent[]
      readonly outbound: OutboundMessage[]
    }
  | {
      readonly ok: false
      readonly error: Error
    }

export function stepLine(state: AdapterState, rawLine: string): StepOutcome {
  const line = rawLine.trim()
  if (!line || line === CHROMIUM_BROWSER_NOISE) {
    return { ok: true, events: [], outbound: [] }
  }
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line)
  const envelope = Option.isSome(decoded) ? record(decoded.value) : undefined
  if (!envelope || envelope.jsonrpc !== "2.0") {
    return { ok: false, error: new Error("Antigravity ACP returned malformed JSONL") }
  }
  const hasId = typeof envelope.id === "number" || typeof envelope.id === "string"
  const hasMethod = typeof envelope.method === "string" && envelope.method.length > 0

  if (hasMethod && hasId) {
    if (envelope.method === "session/request_permission") {
      const params = record(envelope.params)
      const events =
        state.phase === "prompt" && state.sessionId !== undefined && params?.sessionId === state.sessionId
          ? closeOpenSegments(state)
          : []
      return {
        ok: true,
        events,
        outbound: [
          {
            jsonrpc: "2.0",
            id: envelope.id as number | string,
            result: {
              outcome: permissionOutcome(state, envelope.params),
            },
          },
        ],
      }
    }
    return {
      ok: false,
      error: new Error(`Antigravity ACP requested unsupported client method: ${String(envelope.method)}`),
    }
  }

  if (hasMethod && envelope.id === undefined) {
    if (envelope.method === "session/update") {
      return handleSessionUpdate(state, envelope.params)
    }
    return { ok: true, events: [], outbound: [] }
  }

  if (hasId && envelope.method === undefined) {
    return handleResponse(state, envelope.id as number | string, envelope.result, envelope.error)
  }

  return { ok: false, error: new Error("Antigravity ACP returned malformed JSONL") }
}

function handleResponse(
  state: AdapterState,
  id: number | string,
  resultValue: unknown,
  errorValue: unknown,
): StepOutcome {
  if (id !== state.pendingRequestId) {
    return { ok: false, error: new Error("Antigravity ACP returned an unexpected response ID") }
  }
  if (errorValue !== undefined) {
    if (
      record(errorValue)?.code === -32000 &&
      state.phase === "session_new" &&
      state.authenticationMethod &&
      !state.authenticationAttempted
    ) {
      const nextId = state.nextId++
      state.phase = "authenticate"
      state.authenticationAttempted = true
      state.pendingRequestId = nextId
      return {
        ok: true,
        events: [],
        outbound: [
          { jsonrpc: "2.0", id: nextId, method: "authenticate", params: { methodId: state.authenticationMethod } },
        ],
      }
    }
    return { ok: false, error: new Error(formatRpcError(errorValue)) }
  }
  const result = record(resultValue)
  if (!result) {
    return { ok: false, error: new Error("Antigravity ACP returned malformed JSONL") }
  }

  if (state.phase === "init") {
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        error: new Error(`Antigravity ACP returned unsupported protocolVersion: ${String(result.protocolVersion)}`),
      }
    }
    state.authenticationMethod =
      Array.isArray(result.authMethods) &&
      result.authMethods.some((method) => {
        const value = record(method)
        return value?.id === "oauth-personal" && (value.type === undefined || value.type === "agent")
      })
        ? "oauth-personal"
        : undefined
    return newSession(state)
  }

  if (state.phase === "authenticate") return newSession(state)

  if (state.phase === "session_new") {
    const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : ""
    if (!sessionId) {
      return { ok: false, error: new Error("Antigravity ACP did not return a sessionId") }
    }
    state.sessionId = sessionId
    const selectors = findConfigSelectors(result.configOptions)
    if (selectors.modelConfigId) {
      state.queuedRequests.push({
        method: "session/set_config_option",
        params: {
          sessionId,
          configId: selectors.modelConfigId,
          value: state.modelID,
        },
      })
      if (state.effort && selectors.thoughtConfigId) {
        state.queuedRequests.push({
          method: "session/set_config_option",
          params: {
            sessionId,
            configId: selectors.thoughtConfigId,
            value: state.effort,
          },
        })
      }
      return sendNextQueuedOrPrompt(state)
    }
    state.queuedRequests.push({
      method: "session/set_model",
      params: {
        sessionId,
        modelId: state.effort ? `${state.modelID}-${state.effort}` : state.modelID,
      },
    })
    return sendNextQueuedOrPrompt(state)
  }

  if (state.phase === "configure") {
    return sendNextQueuedOrPrompt(state)
  }

  if (state.phase === "prompt") {
    const stopReason = result.stopReason
    if (stopReason !== "end_turn" && stopReason !== "max_tokens") {
      return {
        ok: false,
        error: new Error(`Antigravity ACP stopped with unexpected reason: ${String(stopReason ?? "unknown")}`),
      }
    }
    const finishReason = stopReason === "max_tokens" ? "length" : "stop"
    const events = [
      ...closeOpenSegments(state),
      LLMEvent.stepFinish({ index: 0, reason: finishReason }),
      LLMEvent.finish({ reason: finishReason }),
    ]
    state.phase = "done"
    state.completed = true
    state.pendingRequestId = undefined
    return { ok: true, events, outbound: [] }
  }

  return { ok: false, error: new Error("Antigravity ACP returned an unexpected response after turn completion") }
}

function newSession(state: AdapterState): StepOutcome {
  const id = state.nextId++
  state.phase = "session_new"
  state.pendingRequestId = id
  return {
    ok: true,
    events: [],
    outbound: [{ jsonrpc: "2.0", id, method: "session/new", params: { cwd: state.cwd, mcpServers: state.mcp } }],
  }
}

function sendNextQueuedOrPrompt(state: AdapterState): StepOutcome {
  const next = state.queuedRequests.shift()
  if (next) {
    const id = state.nextId++
    state.phase = "configure"
    state.pendingRequestId = id
    return {
      ok: true,
      events: [],
      outbound: [
        {
          jsonrpc: "2.0",
          id,
          method: next.method,
          params: next.params,
        },
      ],
    }
  }
  const id = state.nextId++
  state.phase = "prompt"
  state.pendingRequestId = id
  return {
    ok: true,
    events: [],
    outbound: [
      {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId: state.sessionId,
          prompt: [
            {
              type: "text",
              text: state.promptText,
            },
          ],
        },
      },
    ],
  }
}

function handleSessionUpdate(state: AdapterState, paramsValue: unknown): StepOutcome {
  const params = record(paramsValue)
  const update = record(params?.update)
  if (!params || !update) {
    return { ok: false, error: new Error("Antigravity ACP returned malformed JSONL") }
  }
  const kind = update.sessionUpdate
  if (kind === "tool_call" || kind === "tool_call_update") {
    if (state.phase === "prompt" && state.sessionId && params.sessionId === state.sessionId) {
      return { ok: true, events: closeOpenSegments(state), outbound: [] }
    }
    return { ok: true, events: [], outbound: [] }
  }
  if (kind !== "agent_thought_chunk" && kind !== "agent_message_chunk") {
    return { ok: true, events: [], outbound: [] }
  }
  if (state.phase !== "prompt" || !state.sessionId || params.sessionId !== state.sessionId) {
    return { ok: false, error: new Error("Antigravity ACP returned an update for an unknown sessionId") }
  }
  if (kind === "agent_thought_chunk") {
    const text = extractChunkText(update.content)
    if (!text) return { ok: true, events: [], outbound: [] }
    const events: LLMEvent[] = []
    if (state.textOpen) {
      state.textOpen = false
      events.push(LLMEvent.textEnd({ id: state.textId }))
    }
    if (!state.reasoningOpen) {
      state.reasoningSeq += 1
      state.reasoningId = state.reasoningSeq === 1 ? REASONING_ID : `${REASONING_ID}-${state.reasoningSeq}`
      state.reasoningOpen = true
      events.push(LLMEvent.reasoningStart({ id: state.reasoningId }))
    }
    events.push(LLMEvent.reasoningDelta({ id: state.reasoningId, text }))
    return { ok: true, events, outbound: [] }
  }
  if (kind === "agent_message_chunk") {
    const text = extractChunkText(update.content)
    if (!text) return { ok: true, events: [], outbound: [] }
    const events: LLMEvent[] = []
    if (state.reasoningOpen) {
      state.reasoningOpen = false
      events.push(LLMEvent.reasoningEnd({ id: state.reasoningId }))
    }
    if (!state.textOpen) {
      state.textSeq += 1
      state.textId = state.textSeq === 1 ? TEXT_ID : `${TEXT_ID}-${state.textSeq}`
      state.textOpen = true
      events.push(LLMEvent.textStart({ id: state.textId }))
    }
    events.push(LLMEvent.textDelta({ id: state.textId, text }))
    return { ok: true, events, outbound: [] }
  }
  return { ok: true, events: [], outbound: [] }
}

function extractChunkText(contentValue: unknown): string {
  const content = record(contentValue)
  if (!content || content.type !== "text" || typeof content.text !== "string") return ""
  return content.text
}

function findConfigSelectors(configOptions: unknown): {
  readonly modelConfigId?: string
  readonly thoughtConfigId?: string
} {
  if (!Array.isArray(configOptions)) return {}
  const items = configOptions.flatMap((item) => {
    const rec = record(item)
    return rec ? [rec] : []
  })
  const modelOption = items.find(
    (item) =>
      item.type === "select" && typeof item.id === "string" && (item.category === "model" || item.id === "model"),
  )
  const thoughtOption = items.find(
    (item) =>
      item.type === "select" &&
      typeof item.id === "string" &&
      (item.category === "thought_level" || item.id === "thought_level" || item.id === "thinking_level"),
  )
  return {
    modelConfigId: typeof modelOption?.id === "string" ? modelOption.id : undefined,
    thoughtConfigId: typeof thoughtOption?.id === "string" ? thoughtOption.id : undefined,
  }
}

export function permissionOutcome(state: AdapterState, paramsValue: unknown): Record<string, unknown> {
  const params = record(paramsValue)
  if (!params) return { outcome: "cancelled" }
  const options = Array.isArray(params.options)
    ? params.options.flatMap((item) => {
        const rec = record(item)
        return rec ? [rec] : []
      })
    : []
  const toolCall = record(params.toolCall)
  const metadata = record(toolCall?._meta)
  const mcp = record(metadata?.mcp)
  const tool =
    metadata?.is_mcp_tool_call === true &&
    mcp?.server === "forge" &&
    typeof mcp.tool === "string" &&
    /^[A-Za-z0-9_.-]+$/.exec(mcp.tool)?.[0] === mcp.tool
      ? `mcp__forge__${mcp.tool}`
      : undefined
  // The official runtime supplies structured MCP metadata, not toolCall.name.
  // Display titles and IDs never authorize execution; conflicting route metadata fails closed.
  if (
    state.phase === "prompt" &&
    state.sessionId !== undefined &&
    params.sessionId === state.sessionId &&
    state.mcp.length > 0 &&
    (toolCall?._meta === undefined
      ? typeof toolCall?.name === "string" && /^mcp__forge__[A-Za-z0-9_.-]+$/.exec(toolCall.name)?.[0] === toolCall.name
      : tool !== undefined && (toolCall?.name === undefined || toolCall.name === tool))
  ) {
    const allow = options.find((item) => typeof item.optionId === "string" && item.kind === "allow_once")
    return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" }
  }
  const reject = options.find((item) => typeof item.optionId === "string" && item.kind === "reject_once")
  if (typeof reject?.optionId === "string") {
    return {
      outcome: "selected",
      optionId: reject.optionId,
    }
  }
  return { outcome: "cancelled" }
}

function formatRpcError(errorValue: unknown): string {
  const err = record(errorValue)
  if (!err) return "Antigravity ACP request failed"
  const code = typeof err.code === "number" ? err.code : undefined
  const message =
    typeof err.message === "string" && err.message.trim() ? err.message.trim() : "Antigravity ACP request failed"
  const data = record(err.data)
  const details =
    typeof data?.details === "string" ? data.details.trim() : typeof err.data === "string" ? err.data.trim() : ""
  if (
    code === -32000 ||
    /auth|credential|login|oauth|token/i.test(message) ||
    /auth|credential|login|oauth|token/i.test(details)
  ) {
    return `Antigravity ACP authentication failed: ${details || message}`
  }
  return details ? `${message}: ${details}` : message
}

export function safeProviderError(cause: unknown): LLMEvent {
  const text = cause instanceof Error ? cause.message : String(cause)
  const message = /credential|auth|login|oauth|token/i.test(text)
    ? "Antigravity ACP needs Google sign-in. Connect Antigravity ACP and select Sign in with Google, then retry."
    : /429|resource_exhausted|rate[ _-]?limit|quota|too many requests/i.test(text)
      ? "Antigravity ACP hit a Google quota or rate limit. Wait before sending another request or switch models."
      : /403|permission_denied|not supported on your plan/i.test(text)
        ? "Antigravity ACP access was denied by Google. Check your Google AI subscription plan and Antigravity ACP sign-in."
        : /handshake timed out/i.test(text)
          ? "Antigravity ACP setup timed out. Check your Antigravity ACP sign-in, installed server, and selected model, then retry."
          : /ENOENT|not found/i.test(text)
            ? "Antigravity ACP was not found. Install `agy_acp_server` or configure its executable path."
            : /malformed|JSON|protocolVersion|unexpected response|sessionId|unsupported client method/i.test(text)
              ? "Antigravity ACP returned malformed JSONL. The installed ACP server may be incompatible."
              : /limit|exceed/i.test(text)
                ? "Antigravity ACP exceeded a bridge safety limit. Reduce the context or output and try again."
                : /supports text only|attachment/i.test(text)
                  ? "Antigravity ACP bridge currently supports text only."
                  : "Antigravity ACP stopped before completing the turn. Check the ACP login and model availability."
  return LLMEvent.providerError({
    message,
    retryable: false,
    ...(isContextOverflow(text) ? { classification: "context-overflow" as const } : {}),
  })
}

function writeJsonLine(stdin: Writable, message: OutboundMessage) {
  if (stdin.destroyed || !stdin.writable) return
  stdin.write(`${JSON.stringify(message)}\n`)
}

const protocol = Protocol.make({
  id: ROUTE_ID,
  body: { schema: Schema.declare((value): value is LLMRequest => value instanceof LLMRequest), from: Effect.succeed },
  stream: {
    event: Schema.declare((value): value is LLMEvent => Schema.is(LLMEvent)(value)),
    initial: () => undefined,
    step: (_, event) => Effect.succeed([undefined, [event]] as const),
  },
})

const transport = (input: {
  executable: string
  modelID: string
  effort?: AntigravityAcpCLI.EffortLevel
}): TransportDef<LLMRequest, LLMRequest, LLMEvent> => ({
  id: ROUTE_ID,
  prepare: (value) => Effect.succeed(value.request),
  frames: (request) =>
    Stream.callback<LLMEvent, LLMError>((queue) =>
      Effect.gen(function* () {
        const token = ClaudeCodeMcp.requestToken(request.metadata)
        if (request.tools.length > 0 && !token) {
          return yield* Effect.fail(error("Antigravity ACP requires the host MCP tool bridge"))
        }
        const promptText = yield* Effect.try({
          try: () => prompt(request),
          catch: (cause) => error(cause instanceof Error ? cause.message : "Could not prepare Antigravity ACP prompt"),
        })

        const activeMcpToken = yield* ClaudeCodeMcp.ActiveMcpToken
        if (activeMcpToken !== undefined && activeTurnTokens.has(activeMcpToken)) {
          return yield* Effect.fail(
            error("Antigravity ACP does not support nested turns inside an active ACP tool call"),
          )
        }

        // Hold the process-wide single-flight permit for the entire subprocess turn so concurrent
        // sessions execute sequentially without racing on `~/.gemini/antigravity-acp/acp_token.json`
        // or firing parallel bursts. Waiting on the permit stays interruptible so queued turns can
        // be cancelled immediately without waiting for the active turn to finish.
        yield* acquireTurnPermit
        if (token) {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              activeTurnTokens.add(token)
            }),
            () =>
              Effect.sync(() => {
                activeTurnTokens.delete(token)
              }),
          )
        }

        const directory = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const dir = mkdtempSync(join(tmpdir(), "turen-antigravity-acp-"))
              mkdirSync(join(dir, "config"), { recursive: true })
              mkdirSync(join(dir, "data"), { recursive: true })
              mkdirSync(join(dir, "workspace"), { recursive: true })
              return dir
            },
            catch: () => error("Could not create Antigravity ACP transport directory"),
          }),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        )
        const env = environment(directory)
        const mcp = token
          ? yield* ClaudeCodeMcp.serve(token).pipe(Effect.mapError((cause) => error(cause.message)))
          : undefined

        const workspaceDir = join(directory, "workspace")
        const state = adapterState({
          modelID: input.modelID,
          effort: input.effort,
          cwd: workspaceDir,
          mcp,
          promptText,
        })

        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const proc = spawn(input.executable, args(), {
              env,
              cwd: workspaceDir,
              stdio: ["pipe", "pipe", "pipe"],
              detached: process.platform !== "win32",
              windowsHide: true,
            })
            const decoder = new TextDecoder()
            let buffer = ""
            let stderr = ""
            let size = 0
            let closed = false

            const done = (failure?: unknown) => {
              if (closed) return
              closed = true
              if (failure !== undefined) Queue.offerUnsafe(queue, safeProviderError(failure))
              Queue.endUnsafe(queue)
            }

            const consume = (line: string) => {
              if (closed) return
              const step = stepLine(state, line)
              if (!step.ok) {
                done(step.error)
                return
              }
              step.events.forEach((event) => Queue.offerUnsafe(queue, event))
              step.outbound.forEach((msg) => writeJsonLine(proc.stdin, msg))
              if (state.completed) {
                if (!proc.stdin.destroyed) proc.stdin.end()
                done()
              }
            }

            Queue.offerUnsafe(queue, LLMEvent.stepStart({ index: 0 }))
            writeJsonLine(proc.stdin, startHandshake(state))

            proc.stdout.on("data", (chunk: Buffer) => {
              if (closed) return
              size += chunk.byteLength
              if (size > OUTPUT_LIMIT) {
                done(new Error("Antigravity ACP output exceeds safety limit"))
                return
              }
              buffer += decoder.decode(chunk, { stream: true })
              let newline = buffer.indexOf("\n")
              while (newline >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, "")
                if (Buffer.byteLength(line) > LINE_LIMIT) {
                  done(new Error("Antigravity ACP line exceeds safety limit"))
                  return
                }
                buffer = buffer.slice(newline + 1)
                consume(line)
                if (closed) return
                newline = buffer.indexOf("\n")
              }
              if (Buffer.byteLength(buffer) > LINE_LIMIT) {
                done(new Error("Antigravity ACP line exceeds safety limit"))
              }
            })
            proc.stdout.on("error", done)
            proc.stderr.on("data", (chunk: Buffer) => {
              stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT)
              // Successful startup diagnostics also contain Google account links (for example upgrades).
              // Only the runtime's explicit browser-authentication instruction requires sign-in.
              if (/^Open the following link to authenticate[^\r\n]*https:\/\/accounts\.google\.com\//im.test(stderr)) {
                done(new Error("Antigravity ACP requires Google authentication in an interactive ACP client"))
              }
            })
            proc.stdin.on("error", done)
            proc.stderr.on("error", done)
            proc.on("error", done)

            const exit = new Promise<void>((resolve) =>
              proc.once("close", (code, signal) => {
                resolve()
                if (closed) return
                const tail = (buffer + decoder.decode()).replace(/\r$/, "")
                if (tail.trim()) {
                  consume(tail)
                }
                if (closed) return
                if (code !== 0 || signal || !state.completed) {
                  done(new Error(stderr.trim() || `Antigravity ACP exited with code ${code}`))
                  return
                }
                done()
              }),
            )
            return { proc, exit, done }
          }),
          (child) =>
            Effect.promise(async () => {
              const cancel = cancelNotification(state)
              if (cancel) {
                writeJsonLine(child.proc.stdin, cancel)
              }
              if (!child.proc.stdin.destroyed) {
                child.proc.stdin.end()
              }
              child.done()
              const signal = (value: NodeJS.Signals) => {
                if (!child.proc.pid) return
                try {
                  if (process.platform === "win32") child.proc.kill(value)
                  else process.kill(-child.proc.pid, value)
                } catch {
                  /* process group already exited */
                }
              }
              signal("SIGTERM")
              const timeout = setTimeout(() => signal("SIGKILL"), 2_000)
              await Promise.race([child.exit, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())])
              clearTimeout(timeout)
              signal("SIGKILL")
            }),
        )
        yield* Effect.sleep(HANDSHAKE_TIMEOUT).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (state.phase !== "prompt" && !state.completed) {
                child.done(new Error("Antigravity ACP handshake timed out"))
              }
            }),
          ),
          Effect.forkScoped,
        )
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Queue.failCause(queue, cause),
        ),
      ),
    ),
})

export const isAntigravityAcp = (model: ModelV2.Info) =>
  model.providerID === AntigravityAcpCLI.ID &&
  model.api.type === "native" &&
  model.api.url === AntigravityAcpCLI.API_URL

export const routeModel = (input: {
  providerID: string
  modelID: string
  executable: string
  effort?: AntigravityAcpCLI.EffortLevel
  defaults: RouteDefaultsInput
}) =>
  Route.make({
    id: ROUTE_ID,
    provider: input.providerID,
    protocol,
    endpoint: Endpoint.path("", { baseURL: "https://antigravity-acp-cli.invalid" }),
    transport: transport(input),
    defaults: input.defaults,
  }).model({ id: input.modelID })

export const model = (input: { model: ModelV2.Info; defaults: RouteDefaultsInput }) => {
  const configured = input.model.request.body[AntigravityAcpCLI.EXECUTABLE_KEY]
  const effort = input.model.request.body[AntigravityAcpCLI.EFFORT_KEY]
  return routeModel({
    providerID: input.model.providerID,
    modelID: input.model.api.id,
    executable:
      AntigravityAcpCLI.resolveExecutable(configured) ??
      (typeof configured === "string" ? configured : AntigravityAcpCLI.DEFAULT_EXECUTABLE),
    effort: AntigravityAcpCLI.isEffortLevel(effort) ? effort : undefined,
    defaults: input.defaults,
  })
}
