import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isContextOverflow, LLMError, LLMEvent, LLMRequest, TransportReason } from "@turenlabs/llm"
import { Endpoint, Protocol, Route, type RouteDefaultsInput, type TransportDef } from "@turenlabs/llm/route"
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import { ClaudeCodeGuidance } from "../../claude-code-guidance"
import { ModelV2 } from "../../model"
import { ClaudeCodeCLI } from "../../provider/claude-code"
import { ClaudeCodeMcp } from "./claude-code-mcp-namespace"

/**
 * Claude Code (local) transport for the v2 runtime.
 *
 * Unlike every other route in this runtime, the "server" is a child process:
 * `claude -p --output-format stream-json` writes exactly the same newline
 * delimited message envelopes the Agent SDK consumes, so the v1 adapter's
 * message mapping ports across unchanged. What is new here is process
 * lifecycle — the subprocess is acquired with `Effect.acquireRelease` so an
 * interrupted turn always tears down the child (and its process group) instead
 * of leaking an orphaned `claude`.
 */

type Prepared = {
  readonly request: LLMRequest
}

const ROUTE_ID = "claude-code-cli"

const PROMPT_LIMIT = 4 * 1024 * 1024
const OUTPUT_LIMIT = 8 * 1024 * 1024
const RAW_OUTPUT_LIMIT = OUTPUT_LIMIT * 4
const TOOL_RESULT_LIMIT = 2 * 1024 * 1024
const ASSISTANT_TEXT_LIMIT = 64 * 1024
const SYSTEM_LIMIT = 96 * 1024
const STDERR_LIMIT = 8 * 1024
/** Grace period between SIGTERM and SIGKILL when tearing the child down. */
const TERMINATE_GRACE = 2_000
const REAP_TIMEOUT = 3_000
const TERMINAL_EXIT_GRACE = 1_000

const API_ERROR_PREFIX = "API Error:"
const MCP_TOOL_PREFIX = "mcp__forge__"
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const TRUNCATED = "\n[truncated by TurenOS]"
const SYSTEM_WORKFLOW_OVERHEAD = encoder.encode(`${ClaudeCodeGuidance.WORKFLOW}\n\n`).byteLength

const TOOL_NAMES = new Map([
  ["Read", "read"],
  ["Glob", "glob"],
  ["Grep", "grep"],
  ["LS", "list"],
  ["WebFetch", "webfetch"],
  ["WebSearch", "websearch"],
  ["Task", "task"],
  ["Bash", "bash"],
  ["Edit", "edit"],
  ["Write", "write"],
  ["TodoWrite", "todowrite"],
  ["AskUserQuestion", "question"],
  ["Skill", "skill"],
])

const protocol = Protocol.make({
  id: ROUTE_ID,
  body: {
    schema: Schema.declare((value): value is LLMRequest => value instanceof LLMRequest),
    from: Effect.succeed,
  },
  stream: {
    event: Schema.declare((value): value is LLMEvent => Schema.is(LLMEvent)(value)),
    initial: () => undefined,
    step: (_, event) => Effect.succeed([undefined, [event]] as const),
  },
})

const transportError = (method: string, message: string) =>
  new LLMError({
    module: "ClaudeCodeBridge",
    method,
    reason: new TransportReason({ message, kind: ROUTE_ID }),
  })

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const toolName = (value: string) =>
  value.startsWith(MCP_TOOL_PREFIX) ? value.slice(MCP_TOOL_PREFIX.length) : (TOOL_NAMES.get(value) ?? value)

const toolInput = (name: string, value: Record<string, unknown>) => {
  const file = name === "read" || name === "edit" || name === "write"
  const edit = name === "edit"
  const skill = name === "skill"
  return {
    ...value,
    ...(file && typeof value.file_path === "string" ? { filePath: value.file_path } : {}),
    ...(edit && typeof value.old_string === "string" ? { oldString: value.old_string } : {}),
    ...(edit && typeof value.new_string === "string" ? { newString: value.new_string } : {}),
    ...(edit && typeof value.replace_all === "boolean" ? { replaceAll: value.replace_all } : {}),
    ...(skill && typeof value.skill === "string" ? { name: value.skill } : {}),
  }
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const bounded = (value: string, limit: number): string => {
  if (encoder.encode(value).byteLength <= limit) return value
  const suffix = encoder.encode(TRUNCATED)
  return decoder.decode(encoder.encode(value).slice(0, Math.max(0, limit - suffix.byteLength - 3))) + TRUNCATED
}

/** Flattens one common-format message into the plain text Claude Code reads on stdin. */
const messageText = (message: LLMRequest["messages"][number]): string =>
  message.content
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "reasoning") return [`[reasoning]\n${part.text}`]
      if (part.type === "media")
        return part.mediaType.startsWith("image/")
          ? [`[image ${part.filename ?? "attachment"} is attached to this conversation]`]
          : [`[${part.filename ?? "attachment"} is attached in TurenOS but is not forwarded to Claude Code]`]
      if (part.type === "tool-call") return [`[tool call ${part.name}] ${json(part.input)}`]
      if (part.type === "tool-result") return [`[tool result ${part.name}] ${json(part.result.value)}`]
      return []
    })
    .join("\n")

/**
 * Claude Code owns its own conversation state, but TurenOS owns the session
 * timeline. Rather than resume a CLI-side session (deferred), every turn
 * replays the TurenOS transcript as a single prompt — the same shape the v1
 * adapter used for un-resumed turns.
 */
export const prompt = (request: LLMRequest): string => {
  const transcript = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${messageText(message)}`)
    .join("\n\n")
  return bounded(transcript || "Continue.", PROMPT_LIMIT)
}

const IMAGE_LIMIT = 8
const IMAGE_BYTES_LIMIT = 8 * 1024 * 1024

type ImageBlock = {
  readonly type: "image"
  readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string }
}

const imageData = (data: string | Uint8Array): string => {
  if (typeof data !== "string") return Buffer.from(data).toString("base64")
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(data)
  return match?.[1] ?? data
}

/**
 * Image parts travel as real content blocks beside the flattened transcript --
 * the CLI accepts them via `--input-format stream-json`. Bounded so one
 * pathological session cannot write an unbounded prompt to the child's stdin;
 * anything past the caps stays behind as the transcript's attachment note.
 */
export const images = (request: LLMRequest): ImageBlock[] => {
  const blocks: ImageBlock[] = []
  let bytes = 0
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "media" || !part.mediaType.startsWith("image/")) continue
      const data = imageData(part.data)
      const size = Math.floor(data.length * 0.75)
      if (blocks.length >= IMAGE_LIMIT || bytes + size > IMAGE_BYTES_LIMIT) return blocks
      bytes += size
      blocks.push({ type: "image", source: { type: "base64", media_type: part.mediaType, data } })
    }
  }
  return blocks
}

/** One stream-json user envelope: the transcript as text plus attached images. */
export const stdinEnvelope = (request: LLMRequest): string =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt(request) }, ...images(request)] },
  })}\n`

export const systemPrompt = (request: LLMRequest): string => {
  const workflow = ClaudeCodeMcp.requestToken(request.metadata) ? ClaudeCodeGuidance.WORKFLOW : ""
  return bounded(
    [
      "You are running inside TurenOS. TurenOS owns the session timeline and renders your work to the user.",
      workflow,
      ...request.system.map((part) => part.text),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    SYSTEM_LIMIT + (workflow ? SYSTEM_WORKFLOW_OVERHEAD : 0),
  )
}

// ---------------------------------------------------------------------------
// Message -> LLMEvent mapping (ported from the v1 adapter)
// ---------------------------------------------------------------------------

type Block =
  | { readonly type: "text"; readonly id: string; pending: string; suppressed: boolean; started: boolean }
  | { readonly type: "reasoning"; readonly id: string }
  | { readonly type: "tool"; readonly id: string; readonly name: string }

/**
 * Per-tool-call lifecycle, keyed by the provider's `toolu_…` id.
 *
 * The CLI describes one tool call across several envelopes and does not order
 * them the way the runner's event contract expects: the completed `assistant`
 * envelope arrives *between* the last `input_json_delta` and the block's
 * `content_block_stop`. The runner treats `tool-call` as implicitly closing the
 * input, so a later `tool-input-end` is a duplicate and kills the drain. Tracking
 * each phase per id — rather than per content-block index — is what guarantees
 * exactly one `tool-input-start`/`tool-input-end` pair, one `tool-call` and one
 * `tool-result` no matter how many envelopes mention the call.
 */
type ToolPhase = {
  readonly name: string
  inputStarted: boolean
  inputEnded: boolean
  called: boolean
  resulted: boolean
}

/** Prompt/response sizes for one provider request, as the CLI reports them. */
export type RequestUsage = {
  readonly nonCached: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export type State = {
  readonly blocks: Map<number, Block>
  readonly tools: Map<string, ToolPhase>
  readonly mcpCalls: Set<string>
  bytes: number
  textBytes: number
  textTruncated: boolean
  textEmitted: boolean
  finished: boolean
  assistantError?: string
  /**
   * Usage of the most recent *top-level* request. Claude Code runs its own
   * agentic loop, so one TurenOS turn is many requests and the terminal `result`
   * envelope reports their sum. Only the last request's prompt describes what
   * currently occupies the context window, so it is tracked as it streams past.
   */
  request?: RequestUsage
}

export const adapterState = (): State => ({
  blocks: new Map(),
  tools: new Map(),
  mcpCalls: new Set(),
  bytes: 0,
  textBytes: 0,
  textTruncated: false,
  textEmitted: false,
  finished: false,
})

const toolPhase = (state: State, id: string, name: string): ToolPhase => {
  const existing = state.tools.get(id)
  if (existing) return existing
  const created: ToolPhase = { name, inputStarted: false, inputEnded: false, called: false, resulted: false }
  state.tools.set(id, created)
  return created
}

/**
 * Closes a streamed tool input exactly once. Emits nothing when the input was
 * never started (no partial-message blocks for this call) — the runner opens and
 * closes it itself on `tool-call`, and an unmatched end would be fatal there.
 */
const endToolInput = (state: State, id: string, name: string): LLMEvent[] => {
  const phase = state.tools.get(id)
  if (!phase || !phase.inputStarted || phase.inputEnded) return []
  phase.inputEnded = true
  return [LLMEvent.toolInputEnd({ id, name: phase.name || name })]
}

const track = (state: State, value: string) => {
  state.bytes += encoder.encode(value).byteLength
  if (state.bytes > OUTPUT_LIMIT) throw new Error("Claude Code output exceeded TurenOS's safety limit")
}

const assistantText = (state: State, value: string): string => {
  if (state.textTruncated) return ""
  const bytes = encoder.encode(value)
  const remaining = Math.max(0, ASSISTANT_TEXT_LIMIT - state.textBytes)
  if (bytes.byteLength <= remaining) {
    state.textBytes += bytes.byteLength
    return value
  }
  state.textBytes = ASSISTANT_TEXT_LIMIT
  state.textTruncated = true
  // A fresh streaming decoder omits an incomplete final code point instead of
  // replacing it with U+FFFD. It is discarded immediately, so nothing buffers
  // into a later assistant delta.
  return new TextDecoder().decode(bytes.slice(0, remaining), { stream: true }) + TRUNCATED
}

const text = (value: unknown): string => {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((item) => {
      const part = record(item)
      if (!part) return []
      if (part.type === "text" && typeof part.text === "string") return [part.text]
      if (part.type === "image") return ["[image]"]
      return []
    })
    .join("\n")
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)

/** Reads one `usage` payload — the shape is identical on `assistant`, `result` and `iterations`. */
const requestUsage = (raw: Record<string, unknown> | undefined): RequestUsage | undefined => {
  if (!raw) return undefined
  return {
    nonCached: number(raw.input_tokens),
    cacheRead: number(raw.cache_read_input_tokens),
    cacheWrite: number(raw.cache_creation_input_tokens),
    output: number(raw.output_tokens),
  }
}

/**
 * Records a top-level request's prompt sizes as its `assistant` envelope
 * streams past. The prompt fields are final the moment the envelope is written;
 * `output_tokens` is only Anthropic's message-start placeholder (`1`), which is
 * why `usage()` prefers `result.usage.iterations` and falls back here.
 */
export const trackRequest = (state: State, message: Record<string, unknown>) => {
  // Sub-agent (`Task`) turns replay with a parent id and occupy their *own*
  // context window, not this one. `result.usage` excludes them too.
  if (message.parent_tool_use_id) return
  const observed = requestUsage(record(record(message.message)?.usage))
  if (!observed) return
  state.request = observed
}

/**
 * Splits the terminal `result` envelope into the two figures the rest of TurenOS
 * needs, because Claude Code conflates them.
 *
 * `result.usage` is the *sum* over every top-level request the CLI made behind
 * this one TurenOS turn — verified against the CLI: two requests reading
 * 24,060 and 24,366 cached prompt tokens report `cache_read_input_tokens:
 * 48,426`. Summed cache reads are not context occupancy; they are a running
 * total that can only ever grow.
 *
 * `result.usage.iterations` carries the final request on its own, which is the
 * figure that describes the window. The last top-level `assistant` envelope
 * corroborates it (both reported 24,366 above) and stands in when the CLI omits
 * `iterations`.
 */
const usage = (state: State, message: Record<string, unknown>) => {
  const raw = record(message.usage) ?? {}
  const turnNonCached = number(raw.input_tokens)
  const turnCacheRead = number(raw.cache_read_input_tokens)
  const turnCacheWrite = number(raw.cache_creation_input_tokens)
  const turnOutput = number(raw.output_tokens)

  const iterations = Array.isArray(raw.iterations) ? raw.iterations : []
  const final = requestUsage(record(iterations[iterations.length - 1])) ??
    state.request ?? {
      // No request was ever observed, so there is nothing to distinguish: a run
      // that produced no `assistant` envelope made at most one request.
      nonCached: turnNonCached,
      cacheRead: turnCacheRead,
      cacheWrite: turnCacheWrite,
      output: turnOutput,
    }

  const input = final.nonCached + final.cacheRead + final.cacheWrite
  return {
    inputTokens: input,
    outputTokens: final.output,
    nonCachedInputTokens: final.nonCached,
    cacheReadInputTokens: final.cacheRead,
    cacheWriteInputTokens: final.cacheWrite,
    totalTokens: input + final.output,
    turn: {
      nonCachedInputTokens: turnNonCached,
      cacheReadInputTokens: turnCacheRead,
      cacheWriteInputTokens: turnCacheWrite,
      outputTokens: turnOutput,
      reasoningTokens: 0,
    },
    providerMetadata: {
      claudeCode: {
        subscription: true,
        totalCostUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0,
      },
    },
  }
}

const apiErrorCode = (value: string): string => {
  const source = value.toLowerCase()
  // Checked first: bridge errors bypass every protocol mapper, so overflow classification
  // happens here or nowhere. Unclassified, the runner settled the turn terminally instead of
  // attempting compaction recovery — the gpt-5.6-luna failure mode, but on the one provider
  // path where it could never self-heal.
  if (isContextOverflow(value)) return "context_overflow"
  if (source.includes("usage") || source.includes("billing")) return "billing_error"
  if (source.includes("rate limit")) return "rate_limit"
  if (source.includes("auth") || source.includes("login")) return "authentication_failed"
  if (source.includes("overload") || source.includes("unavailable")) return "overloaded"
  if (source.includes("model") && source.includes("not found")) return "model_not_found"
  return "unknown"
}

const blockedPromptHook = (message: Record<string, unknown>) =>
  message.num_turns === 0 &&
  message.duration_api_ms === 0 &&
  typeof message.result === "string" &&
  /^UserPromptSubmit operation blocked by hook:\r?\n[\s\S]*?\r?\n\r?\nOriginal prompt:(?:[ \t]|\r?\n|$)/.test(
    message.result,
  )

const errorMessage = (message: Record<string, unknown>, assistantError?: string): string => {
  if (assistantError === "hook_blocked")
    return "Claude Code blocked this request in its UserPromptSubmit hook. Check your Claude Code hook configuration and try again."
  if (assistantError === "authentication_failed")
    return "Claude Code is not authenticated. Run `claude auth login`, then restart TurenOS."
  if (assistantError === "billing_error") {
    if (typeof message.result === "string" && message.result.toLowerCase().includes("usage credits are required"))
      return "The selected Claude Code model requires available usage credits. Enable extra usage in Claude settings or choose another Claude Code model."
    return "Claude Code subscription usage is exhausted. Check claude.ai/settings/usage and try again."
  }
  if (assistantError === "rate_limit") return "Claude Code reached a subscription rate limit. Try again later."
  if (assistantError === "context_overflow")
    return "The conversation exceeded the model's context window before Claude Code could reply."
  if (assistantError === "overloaded" || assistantError === "server_error")
    return "Claude Code is temporarily unavailable. Try again shortly."
  if (assistantError === "model_not_found") return "The selected Claude Code model is not available for this account."
  if (assistantError === "max_output_tokens") return "Claude Code reached its output-token limit."
  if (message.subtype === "error_max_turns") return "Claude Code reached its turn limit."
  if (message.subtype === "error_max_budget_usd") return "Claude Code stopped at its configured budget limit."
  return "Claude Code could not complete this request. Check `claude auth status` and try again."
}

/**
 * Maps one `stream-json` envelope onto common `LLMEvent`s. Tool calls are
 * reported with `providerExecuted: true` — Claude Code runs its own tools, so
 * the v2 runner records them and waits for the matching result rather than
 * executing anything itself.
 */
export const toEvents = (state: State, message: Record<string, unknown>): LLMEvent[] => {
  if (state.finished) return []
  if (message.type === "stream_event") {
    if (message.parent_tool_use_id) return []
    const event = record(message.event)
    if (!event) return []
    const index = typeof event.index === "number" ? event.index : -1
    if (event.type === "content_block_start") {
      const block = record(event.content_block)
      if (!block) return []
      if (block.type === "text") {
        const id = `${String(message.uuid)}:${index}`
        state.blocks.set(index, { type: "text", id, pending: "", suppressed: false, started: false })
        return []
      }
      if (block.type === "thinking") {
        const id = `${String(message.uuid)}:${index}`
        state.blocks.set(index, { type: "reasoning", id })
        return [LLMEvent.reasoningStart({ id })]
      }
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const name = toolName(block.name)
        state.blocks.set(index, { type: "tool", id: block.id, name })
        if (block.name.startsWith(MCP_TOOL_PREFIX)) {
          state.mcpCalls.add(block.id)
          return []
        }
        const phase = toolPhase(state, block.id, name)
        if (phase.inputStarted) return []
        phase.inputStarted = true
        return [LLMEvent.toolInputStart({ id: block.id, name })]
      }
      return []
    }
    if (event.type === "content_block_delta") {
      const block = state.blocks.get(index)
      const delta = record(event.delta)
      if (!block || !delta) return []
      if (block.type === "text" && delta.type === "text_delta") {
        if (typeof delta.text !== "string") throw new Error("Claude Code returned a malformed text delta")
        track(state, delta.text)
        if (block.suppressed) return []
        block.pending += delta.text
        // Claude Code streams transport failures as ordinary assistant text.
        // Hold the prefix back until it is clear which it is, so a real answer
        // beginning with "API" is never swallowed.
        if (API_ERROR_PREFIX.startsWith(block.pending)) return []
        if (block.pending.startsWith(API_ERROR_PREFIX)) {
          block.suppressed = true
          state.assistantError ??= apiErrorCode(block.pending)
          block.pending = ""
          return []
        }
        const output = assistantText(state, block.pending)
        block.pending = ""
        if (!output) return []
        state.textEmitted = true
        const start = block.started ? [] : [LLMEvent.textStart({ id: block.id })]
        block.started = true
        return [...start, LLMEvent.textDelta({ id: block.id, text: output })]
      }
      if (block.type === "reasoning" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        track(state, delta.thinking)
        return [LLMEvent.reasoningDelta({ id: block.id, text: delta.thinking })]
      }
      if (block.type === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        if (state.mcpCalls.has(block.id)) return []
        track(state, delta.partial_json)
        return [LLMEvent.toolInputDelta({ id: block.id, name: block.name, text: delta.partial_json })]
      }
      return []
    }
    if (event.type === "content_block_stop") {
      const block = state.blocks.get(index)
      state.blocks.delete(index)
      if (!block) return []
      if (block.type === "text") {
        if (block.pending.startsWith(API_ERROR_PREFIX)) {
          state.assistantError ??= apiErrorCode(block.pending)
          return block.started ? [LLMEvent.textEnd({ id: block.id })] : []
        }
        if (block.pending) {
          const output = assistantText(state, block.pending)
          if (!output) return block.started ? [LLMEvent.textEnd({ id: block.id })] : []
          state.textEmitted = true
          return [
            ...(block.started ? [] : [LLMEvent.textStart({ id: block.id })]),
            LLMEvent.textDelta({ id: block.id, text: output }),
            LLMEvent.textEnd({ id: block.id }),
          ]
        }
        return block.started ? [LLMEvent.textEnd({ id: block.id })] : []
      }
      if (block.type === "reasoning") return [LLMEvent.reasoningEnd({ id: block.id })]
      // No-op when the `assistant` envelope already closed this input.
      return endToolInput(state, block.id, block.name)
    }
    return []
  }

  if (message.type === "assistant") {
    if (typeof message.error === "string") state.assistantError ??= message.error
    trackRequest(state, message)
    // Sub-agent (`Task`) turns replay their own tool traffic with a parent id.
    // Surfacing it would open top-level tool calls TurenOS never started and can
    // never settle; the parent `Task` call carries the visible result.
    if (message.parent_tool_use_id) return []
    const body = record(message.message)
    const blocks = Array.isArray(body?.content) ? body.content : []
    return blocks.flatMap((entry) => {
      const block = record(entry)
      if (!block || block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string")
        return []
      const name = toolName(block.name)
      if (state.mcpCalls.has(block.id) || block.name.startsWith(MCP_TOOL_PREFIX)) return []
      const phase = toolPhase(state, block.id, name)
      if (phase.called) return []
      phase.called = true
      return [
        // Close the streamed input first: the runner ends it implicitly on
        // `tool-call`, and the block's own `content_block_stop` still arrives
        // afterwards.
        ...endToolInput(state, block.id, block.name),
        LLMEvent.toolCall({
          id: block.id,
          name: phase.name,
          input: toolInput(phase.name, record(block.input) ?? {}),
          providerExecuted: true,
        }),
      ]
    })
  }

  if (message.type === "user") {
    if (message.parent_tool_use_id) return []
    const body = record(message.message)
    const blocks = Array.isArray(body?.content) ? body.content : []
    return blocks.flatMap((entry) => {
      const block = record(entry)
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") return []
      if (state.mcpCalls.has(block.tool_use_id)) return []
      const phase = state.tools.get(block.tool_use_id)
      if (!phase?.called || phase.resulted) return []
      phase.resulted = true
      const output = bounded(text(block.content), TOOL_RESULT_LIMIT)
      track(state, output)
      return [
        LLMEvent.toolResult({
          id: block.tool_use_id,
          name: phase.name,
          result: { type: block.is_error === true ? "error" : "text", value: output },
          providerExecuted: true,
        }),
      ]
    })
  }

  if (message.type === "result") {
    const result = typeof message.result === "string" ? message.result : undefined
    const hookBlocked = blockedPromptHook(message)
    if (hookBlocked) state.assistantError = "hook_blocked"
    if (!hookBlocked && result && (message.is_error === true || result.startsWith(API_ERROR_PREFIX))) {
      const resultError = apiErrorCode(result)
      if (resultError !== "unknown") state.assistantError = resultError
    }
    const normalized = usage(state, message)
    const succeeded = message.subtype === "success" && message.is_error !== true && !state.assistantError
    const reason = succeeded ? "stop" : message.subtype === "error_max_turns" ? "length" : "error"
    if (succeeded && !state.textEmitted && result) track(state, result)
    const fallback = succeeded && !state.textEmitted && result ? assistantText(state, result) : undefined
    state.finished = true
    if (!succeeded) {
      const retryable =
        state.assistantError === "rate_limit" ||
        state.assistantError === "overloaded" ||
        state.assistantError === "server_error"
      return [
        LLMEvent.providerError({
          message: errorMessage(message, state.assistantError),
          retryable,
          // The runner's one-shot overflow compaction keys on this classification.
          ...(state.assistantError === "context_overflow" ? { classification: "context-overflow" as const } : {}),
        }),
      ]
    }
    const id = `${typeof message.uuid === "string" ? message.uuid : "result"}:result`
    return [
      ...(fallback
        ? [LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text: fallback }), LLMEvent.textEnd({ id })]
        : []),
      LLMEvent.stepFinish({ index: 0, reason, usage: normalized }),
      LLMEvent.finish({ reason, usage: normalized }),
    ]
  }

  return []
}

export const safeProviderError = (error: unknown): LLMEvent => {
  const source = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  // Overflow arriving as a raw stream/exit error rather than a result envelope still needs the
  // classification, even though the friendly message below replaces the original text.
  const classification = isContextOverflow(source) ? ("context-overflow" as const) : undefined
  const message =
    source.includes("malformed") || source.includes("stream-json")
      ? "Claude Code returned an invalid response. Update the `claude` CLI and try again."
      : source.includes("output exceeded") || source.includes("output line exceeded")
        ? "Claude Code returned more output than TurenOS can safely process."
        : source.includes("auth") || source.includes("login")
          ? "Claude Code is not authenticated. Run `claude auth login`, then restart TurenOS."
          : source.includes("enoent") || source.includes("not found") || source.includes("executable")
            ? "Claude Code was not found. Install the `claude` CLI or configure its executable path."
            : "Claude Code stopped unexpectedly. Check `claude auth status` and try again."
  return LLMEvent.providerError({ message, retryable: false, ...(classification ? { classification } : {}) })
}

/**
 * Message for a child that never emits a terminal `result`. Prefers whatever
 * the CLI wrote to stderr (that is where a missing binary, a logged-out CLI, or
 * a bad flag reports itself) and falls back to the exit status.
 */
export const exitError = (input: {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}): LLMEvent => {
  const stderr = input.stderr.trim()
  if (stderr) return safeProviderError(new Error(stderr))
  if (input.signal)
    return LLMEvent.providerError({ message: `Claude Code was terminated (${input.signal}).`, retryable: false })
  return LLMEvent.providerError({
    message: `Claude Code exited with code ${input.code ?? "unknown"} before completing the turn. Check \`claude auth status\` and try again.`,
    retryable: false,
  })
}

// ---------------------------------------------------------------------------
// Child process lifecycle
// ---------------------------------------------------------------------------

type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

type Child = {
  readonly proc: ChildProcess
  readonly exit: Promise<Exit>
  stderr: string
}

/** `detached` puts the child in its own process group so teardown reaps grandchildren too. */
const GROUP_KILL = process.platform !== "win32"

const signal = (child: Child, value: NodeJS.Signals) => {
  const pid = child.proc.pid
  if (pid === undefined) return
  try {
    if (GROUP_KILL) process.kill(-pid, value)
    else child.proc.kill(value)
  } catch {
    // ESRCH — already gone. Fall back to the direct handle in case only the
    // group lookup failed.
    try {
      child.proc.kill(value)
    } catch {
      /* already reaped */
    }
  }
}

const settled = (child: Child) => child.proc.exitCode !== null || child.proc.signalCode !== null

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())

/**
 * SIGTERM the process group, then SIGKILL anything still alive. Always awaited
 * (bounded) so an interrupted turn cannot leave a detached `claude` behind.
 */
const terminate = async (child: Child) => {
  if (settled(child) && !GROUP_KILL) return
  signal(child, "SIGTERM")
  await Promise.race([child.exit, after(TERMINATE_GRACE)])
  if (settled(child) && !GROUP_KILL) return
  // The direct process can exit while a SIGTERM-resistant descendant keeps the
  // process group alive. Always issue the final group reap on POSIX.
  signal(child, "SIGKILL")
  await Promise.race([child.exit, after(REAP_TIMEOUT)])
}

/**
 * Native mutation tools are unavailable: they bypass TurenOS's permissions,
 * interceptors, snapshots and output settlement. The private MCP server exposes
 * the current turn's policy-filtered TurenOS mutations instead. Claude preapproves
 * only that explicit server; TurenOS remains the authority that can ask the user.
 */
export const args = (input: {
  readonly modelID: string
  readonly systemFile: string
  readonly effort?: ClaudeCodeCLI.EffortLevel
  readonly mcpFile?: string
  readonly settingsFile?: string
}): string[] => [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model",
  input.modelID,
  // TurenOS owns session history; do not write into the user's ~/.claude sessions.
  "--no-session-persistence",
  // Repository and user settings can install hooks or provider routing that
  // executes outside TurenOS's policy-filtered tool boundary.
  "--setting-sources",
  "",
  ...(input.settingsFile ? ["--settings", input.settingsFile] : []),
  // Only the private turn-scoped TurenOS MCP server may load.
  "--strict-mcp-config",
  ...(input.mcpFile
    ? ["--mcp-config", input.mcpFile, "--permission-mode", "dontAsk", "--allowedTools", `${MCP_TOOL_PREFIX}*`]
    : []),
  // Built-ins execute inside Claude Code and bypass TurenOS's permissions and
  // durable tool settlement. Every available tool comes from the private MCP.
  "--tools",
  "",
  // Omitted entirely when no variant is selected so the CLI applies whatever
  // default it (and the user's own settings) would normally use. TurenOS does not
  // get to pick an effort level on the user's behalf.
  ...(input.effort ? ["--effort", input.effort] : []),
  "--append-system-prompt-file",
  input.systemFile,
]

const promptFiles = (
  request: LLMRequest,
  mcp: { readonly url: string; readonly hookUrl: string; readonly authorization: string } | undefined,
) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => mkdtempSync(join(tmpdir(), "forge-claude-system-")),
      catch: (error) =>
        transportError(
          "systemPrompt",
          error instanceof Error ? error.message : "Claude Code system prompt directory could not be prepared",
        ),
    }),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((directory) =>
      Effect.try({
        try: () => {
          const system = join(directory, "prompt.txt")
          writeFileSync(system, systemPrompt(request), { mode: 0o600 })
          const config = mcp ? join(directory, "mcp.json") : undefined
          const settings = mcp ? join(directory, "settings.json") : undefined
          if (config && mcp)
            writeFileSync(
              config,
              JSON.stringify({
                mcpServers: {
                  forge: {
                    type: "http",
                    url: mcp.url,
                    headers: { Authorization: mcp.authorization },
                  },
                },
              }),
              { mode: 0o600 },
            )
          if (settings && mcp)
            writeFileSync(
              settings,
              JSON.stringify({
                allowedHttpHookUrls: [mcp.hookUrl],
                hooks: {
                  PostToolBatch: [
                    {
                      hooks: [
                        {
                          type: "http",
                          url: mcp.hookUrl,
                          headers: { Authorization: mcp.authorization },
                          timeout: 2,
                        },
                      ],
                    },
                  ],
                },
              }),
              { mode: 0o600 },
            )
          return { directory, system, mcp: config, settings }
        },
        catch: (error) =>
          transportError(
            "systemPrompt",
            error instanceof Error ? error.message : "Claude Code system prompt could not be prepared",
          ),
      }),
    ),
  )

const launch = (input: {
  readonly executable: string
  readonly directory: string
  readonly modelID: string
  readonly systemFile: string
  readonly effort?: ClaudeCodeCLI.EffortLevel
  readonly mcpFile?: string
  readonly settingsFile?: string
}) =>
  Effect.try({
    try: (): Child => {
      // batou:ignore injection -- `executable` is a `which`-resolved path from a
      // fixed default or operator config, argv is an array (no shell), and
      // prompt contents travel through stdin and a private temporary file.
      const proc = spawn(input.executable, args(input), {
        cwd: input.directory,
        env: ClaudeCodeCLI.subscriptionEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: GROUP_KILL,
        windowsHide: true,
      })
      const child: Child = {
        proc,
        stderr: "",
        exit: new Promise<Exit>((resolve) => {
          proc.on("close", (code, sig) => resolve({ code, signal: sig }))
          proc.on("error", () => resolve({ code: null, signal: null }))
        }),
      }
      proc.on("error", (error) => {
        if (child.stderr.length < STDERR_LIMIT) child.stderr += error.message
      })
      proc.stdin?.on("error", () => {
        /* EPIPE when the child exits before the prompt is fully written */
      })
      proc.stderr?.on("data", (chunk: Buffer) => {
        if (child.stderr.length >= STDERR_LIMIT) return
        child.stderr += chunk.toString("utf8").slice(0, STDERR_LIMIT - child.stderr.length)
      })
      return child
    },
    catch: (error) => transportError("spawn", error instanceof Error ? error.message : "Claude Code could not start"),
  })

const writePrompt = (child: Child, value: string) => {
  const stdin = child.proc.stdin
  if (!stdin) return
  stdin.on("error", () => {
    /* EPIPE when the child exits before the prompt is fully written */
  })
  stdin.end(value)
}

const safeParse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Drives the child from Node's event handlers straight into the stream queue.
 *
 * The events are deliberately *pushed* rather than pulled with `for await`:
 * a pull-based reader parks inside the iterator until the child writes again,
 * which makes teardown wait on a process that may be silent for minutes (a long
 * tool call, a slow first token). Pushing keeps the only blocking operation on
 * the Effect side — an interruptible queue take — so an interrupted turn closes
 * the scope immediately and the release handler gets to kill the child.
 */
const pump = (child: Child, promptText: string, queue: Queue.Queue<LLMEvent, LLMError | Cause.Done>) => {
  const state = adapterState()
  const stdoutDecoder = new TextDecoder()
  let buffer = ""
  let rawBytes = 0
  let closed = false
  let terminalEvents: ReadonlyArray<LLMEvent> | undefined
  let terminalTimer: ReturnType<typeof setTimeout> | undefined
  const emit = (events: ReadonlyArray<LLMEvent>) => {
    for (const event of events) Queue.offerUnsafe(queue, event)
  }
  const finish = (event?: LLMEvent) => {
    if (closed) return
    closed = true
    if (terminalTimer) clearTimeout(terminalTimer)
    if (event) Queue.offerUnsafe(queue, event)
    Queue.endUnsafe(queue)
  }
  const consume = (line: string) => {
    if (state.finished) return
    const parsed = record(safeParse(line))
    if (!parsed) throw new Error("Claude Code returned malformed stream-json output")
    const events = toEvents(state, parsed)
    if (state.finished) {
      terminalEvents = events
      // Preserve the contradictory-success check for a briefly delayed nonzero
      // exit, but never let a CLI that emitted its terminal result strand TurenOS.
      terminalTimer = setTimeout(() => {
        if (closed || !terminalEvents) return
        emit(terminalEvents)
        finish()
      }, TERMINAL_EXIT_GRACE)
      terminalTimer.unref?.()
      return
    }
    emit(events)
  }

  emit([LLMEvent.stepStart({ index: 0 })])
  const stdout = child.proc.stdout
  stdout?.on("data", (chunk: Buffer) => {
    if (closed) return
    try {
      rawBytes += chunk.byteLength
      if (rawBytes > RAW_OUTPUT_LIMIT) throw new Error("Claude Code raw output exceeded TurenOS's safety limit")
      buffer += stdoutDecoder.decode(chunk, { stream: true })
      if (Buffer.byteLength(buffer, "utf8") > OUTPUT_LIMIT)
        throw new Error("Claude Code output line exceeded TurenOS's safety limit")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (line) consume(line)
      }
    } catch (error) {
      // Output-limit breach or a malformed envelope: report it and stop reading.
      finish(safeProviderError(error))
    }
  })
  stdout?.on("error", (error) => finish(safeProviderError(error)))
  void child.exit.then((exit) => {
    if (closed) return
    buffer += stdoutDecoder.decode()
    const trailing = buffer.trim()
    buffer = ""
    if (trailing) {
      try {
        consume(trailing)
      } catch (error) {
        return finish(safeProviderError(error))
      }
    }
    if (state.finished) {
      if (terminalEvents?.some(LLMEvent.is.providerError)) {
        emit(terminalEvents)
        return finish()
      }
      if (exit.code === 0 && exit.signal === null) {
        if (terminalEvents) emit(terminalEvents)
        return finish()
      }
    }
    finish(exitError({ ...exit, stderr: child.stderr }))
  })
  writePrompt(child, promptText)
}

const transport = (input: {
  readonly executable: string
  readonly directory: string
  readonly modelID: string
  readonly effort?: ClaudeCodeCLI.EffortLevel
}): TransportDef<LLMRequest, Prepared, LLMEvent> => ({
  id: ROUTE_ID,
  prepare: (value) => Effect.succeed({ request: value.request }),
  frames: (prepared) =>
    Stream.callback<LLMEvent, LLMError>((queue) =>
      Effect.gen(function* () {
        const token = ClaudeCodeMcp.requestToken(prepared.request.metadata)
        const mcp = token
          ? yield* ClaudeCodeMcp.serve(token).pipe(Effect.mapError((error) => transportError("mcp", error.message)))
          : undefined
        const files = yield* promptFiles(prepared.request, mcp)
        const child = yield* Effect.acquireRelease(
          launch({
            ...input,
            systemFile: files.system,
            mcpFile: files.mcp,
            settingsFile: files.settings,
          }),
          // Runs on interrupt as well as on normal completion, so cancelling a
          // turn kills the CLI and every process it spawned.
          (child) => Effect.promise(() => terminate(child)),
        )
        yield* Effect.sync(() => pump(child, stdinEnvelope(prepared.request), queue))
      }).pipe(
        // `Stream.callback` forks this register effect and discards its exit: a
        // failure (or defect) that escapes here never reaches the consumer, and
        // the turn hangs forever on a queue nothing will ever feed or close.
        // Route every non-interrupt cause into the queue so acquisition
        // failures (MCP bridge, prompt files, spawn) fail the stream visibly.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Queue.failCause(queue, cause),
        ),
      ),
    ),
})

export const isClaudeCode = (model: ModelV2.Info) =>
  model.providerID === ClaudeCodeCLI.ID && model.api.type === "native" && model.api.url === ClaudeCodeCLI.API_URL

const stringOption = (body: Record<string, unknown>, key: string) => {
  const value = body[key]
  return typeof value === "string" ? value : undefined
}

export const routeModel = (input: {
  readonly providerID: string
  readonly modelID: string
  readonly executable: string
  readonly directory: string
  readonly effort?: ClaudeCodeCLI.EffortLevel
  readonly defaults: RouteDefaultsInput
}) =>
  Route.make({
    id: ROUTE_ID,
    provider: input.providerID,
    protocol,
    // The transport never performs a request; the route machinery only
    // requires a syntactically valid baseURL to build a model.
    endpoint: Endpoint.path("", { baseURL: "https://claude-code-cli.invalid" }),
    transport: transport(input),
    defaults: input.defaults,
  }).model({ id: input.modelID })

export const model = (input: { readonly model: ModelV2.Info; readonly defaults: RouteDefaultsInput }) => {
  const configured = stringOption(input.model.request.body, ClaudeCodeCLI.EXECUTABLE_KEY)
  // Fall back to the configured name verbatim when `which` cannot resolve it so
  // the spawn fails visibly on the operator's value instead of silently running
  // a different binary.
  const executable = ClaudeCodeCLI.resolveExecutable(configured) ?? configured ?? ClaudeCodeCLI.DEFAULT_EXECUTABLE
  const directory = stringOption(input.model.request.body, ClaudeCodeCLI.DIRECTORY_KEY) ?? process.cwd()
  // `withVariant` has already merged the selected variant's body in by now, so
  // the key is present exactly when a published effort variant is in force.
  // Anything else — a stale variant id, a hand-written config value — is dropped
  // rather than forwarded, because the CLI would only warn and ignore it.
  const requestedEffort = input.model.request.body[ClaudeCodeCLI.EFFORT_KEY]
  const effort = ClaudeCodeCLI.isEffortLevel(requestedEffort) ? requestedEffort : undefined
  return routeModel({
    providerID: input.model.providerID,
    modelID: input.model.api.id,
    executable,
    directory,
    effort,
    defaults: input.defaults,
  })
}

export * as ClaudeCodeBridge from "./claude-code-bridge"
