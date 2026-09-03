import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@turenlabs/llm"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly snapshot?: string
}

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const MAX_DURABLE_TOOL_OUTPUT_BYTES = 512 * 1024
const DURABLE_TOOL_OUTPUT_TRUNCATION = "\n[tool output truncated before durable storage]"

/**
 * The assistant message's token record: what the model's context window holds
 * as of the turn's last provider request. Every AI-SDK provider makes exactly
 * one request per assistant message, so its usage is already per-request;
 * transports that loop internally report the final request here and the run
 * total separately on `usage.turn`.
 */
const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

/**
 * Everything the turn processed, for accounting that is cumulative by nature
 * (goal usage, cost). Falls back to the per-request figures for the
 * providers where one turn is one request and the two are the same number.
 */
const processed = (usage: Usage | undefined) => {
  const turn = usage?.turn
  if (!turn) return tokens(usage)
  return {
    input: safe(turn.nonCachedInputTokens),
    output: Math.max(0, safe(turn.outputTokens) - safe(turn.reasoningTokens)),
    reasoning: safe(turn.reasoningTokens),
    cache: { read: safe(turn.cacheReadInputTokens), write: safe(turn.cacheWriteInputTokens) },
  }
}

export type StepTokens = ReturnType<typeof tokens>

/**
 * How one provider turn settled.
 *
 * `tokens` and `processed` are two different quantities and must never be
 * substituted for one another: `tokens` is context occupancy for a single
 * request, `processed` is everything the turn ran through and therefore
 * everything that was billed. `metadata` is the provider's raw settlement
 * payload, kept for the billing paths that read a provider-authoritative
 * charge instead of deriving one from token counts.
 */
export type StepSettlement = {
  readonly finish: string
  readonly tokens: StepTokens
  readonly processed: StepTokens
  readonly metadata?: ProviderMetadata
}

const objectRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const record = (value: unknown): Record<string, unknown> => objectRecord(value) ?? { value }

const boundedRecord = (value: unknown) => {
  const result = record(value)
  return estimatedJsonBytes(result, MAX_DURABLE_TOOL_OUTPUT_BYTES) <= MAX_DURABLE_TOOL_OUTPUT_BYTES
    ? result
    : { truncated: true }
}

// Keep the estimate conservative so sizing a provider result never creates a second copy of a
// multi-megabyte payload just to call JSON.stringify. The multiplier covers JSON escaping.
function estimatedJsonBytes(value: unknown, limit: number, seen = new Set<object>()): number {
  if (limit <= 0) return Number.POSITIVE_INFINITY
  if (value === undefined) return 0
  if (value === null) return 4
  if (typeof value === "string") return Math.min(limit + 1, Buffer.byteLength(value, "utf8") * 8 + 2)
  if (typeof value === "number" || typeof value === "boolean") return 32
  if (typeof value !== "object") return limit + 1
  if (seen.has(value)) return limit + 1
  seen.add(value)

  let size = Array.isArray(value) ? 2 : 2
  const add = (key: string, item: unknown) => {
    size +=
      (Array.isArray(value) ? 1 : Buffer.byteLength(key, "utf8") * 8 + 3) + estimatedJsonBytes(item, limit - size, seen)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      add("", item)
      if (size > limit) break
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      add(key, item)
      if (size > limit) break
    }
  }
  seen.delete(value)
  return size
}

function truncateText(value: string, maximumBytes: number, suffix = DURABLE_TOOL_OUTPUT_TRUNCATION) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value
  const suffixBytes = Buffer.byteLength(suffix, "utf8")
  if (suffixBytes >= maximumBytes) return safePrefix(value, Math.floor(maximumBytes / 2))
  const prefixBytes = maximumBytes - suffixBytes
  let head = value.slice(0, prefixBytes)
  while (Buffer.byteLength(head, "utf8") > prefixBytes) head = head.slice(0, -1)
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1)
  return `${head}${suffix}`
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff
}

function safePrefix(value: string, length: number) {
  const result = value.slice(0, length)
  return isHighSurrogate(result.charCodeAt(result.length - 1)) ? result.slice(0, -1) : result
}

const message = (value: unknown) => {
  if (typeof value === "string") return truncateText(value, MAX_DURABLE_TOOL_OUTPUT_BYTES)
  if (estimatedJsonBytes(value, MAX_DURABLE_TOOL_OUTPUT_BYTES) > MAX_DURABLE_TOOL_OUTPUT_BYTES)
    return DURABLE_TOOL_OUTPUT_TRUNCATION.trimStart()
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const raw = objectRecord(result.value)
  if (value === undefined && result.type === "json" && typeof raw?.output === "string") {
    return {
      structured: objectRecord(raw.metadata) ?? {},
      content: [{ type: "text", text: raw.output }],
    }
  }
  if (value === undefined && result.type === "text" && typeof result.value !== "string") {
    return {
      structured: {},
      content: [{ type: "text", text: message(result.value) }],
    }
  }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

function boundedToolOutput(value: SettledOutput): SettledOutput {
  if ("error" in value) return value
  // Provider-executed results are stored both as display content and as a compatibility result.
  // Bound the shared display half before the caller derives the second representation.
  let structured =
    estimatedJsonBytes({ structured: value.structured, content: [] }, MAX_DURABLE_TOOL_OUTPUT_BYTES) <=
    MAX_DURABLE_TOOL_OUTPUT_BYTES
      ? value.structured
      : { truncated: true }
  const content: Array<ToolOutput["content"][number]> = []
  const marker = { type: "text" as const, text: DURABLE_TOOL_OUTPUT_TRUNCATION.trimStart() }

  for (const item of value.content) {
    const candidate = { structured, content: [...content, item] }
    if (estimatedJsonBytes(candidate, MAX_DURABLE_TOOL_OUTPUT_BYTES) <= MAX_DURABLE_TOOL_OUTPUT_BYTES) {
      content.push(item)
      continue
    }
    if (item.type !== "text") {
      if (
        estimatedJsonBytes({ structured, content: [...content, marker] }, MAX_DURABLE_TOOL_OUTPUT_BYTES) <=
        MAX_DURABLE_TOOL_OUTPUT_BYTES
      )
        content.push(marker)
      else {
        structured = { truncated: true }
        content.length = 0
        content.push(marker)
      }
      break
    }

    let low = 0
    let high = item.text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const text = `${safePrefix(item.text, middle)}${DURABLE_TOOL_OUTPUT_TRUNCATION}`
      if (
        estimatedJsonBytes({ structured, content: [...content, { ...item, text }] }, MAX_DURABLE_TOOL_OUTPUT_BYTES) <=
        MAX_DURABLE_TOOL_OUTPUT_BYTES
      )
        low = middle
      else high = middle - 1
    }
    const text = `${safePrefix(item.text, low)}${DURABLE_TOOL_OUTPUT_TRUNCATION}`
    if (
      estimatedJsonBytes({ structured, content: [...content, { ...item, text }] }, MAX_DURABLE_TOOL_OUTPUT_BYTES) <=
      MAX_DURABLE_TOOL_OUTPUT_BYTES
    )
      content.push({ ...item, text })
    else {
      structured = { truncated: true }
      content.length = 0
      content.push(marker)
    }
    break
  }

  return { structured, content }
}

function boundedToolResult(result: ToolResultValue, output?: SettledOutput): ToolResultValue {
  if (estimatedJsonBytes(result, MAX_DURABLE_TOOL_OUTPUT_BYTES) <= MAX_DURABLE_TOOL_OUTPUT_BYTES) return result
  if (output && !("error" in output)) return ToolOutput.toResultValue(output)
  if (result.type === "error" || result.type === "text") {
    return {
      type: result.type,
      value:
        typeof result.value === "string"
          ? truncateText(result.value, MAX_DURABLE_TOOL_OUTPUT_BYTES)
          : DURABLE_TOOL_OUTPUT_TRUNCATION.trimStart(),
    }
  }
  return { type: "text", value: DURABLE_TOOL_OUTPUT_TRUNCATION.trimStart() }
}

function boundedProviderMetadata(value: ProviderMetadata | undefined) {
  return value === undefined ||
    estimatedJsonBytes(value, MAX_DURABLE_TOOL_OUTPUT_BYTES) <= MAX_DURABLE_TOOL_OUTPUT_BYTES
    ? value
    : undefined
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  let providerRetrySafe = true
  let stepStarted = false
  let stepSettlement: StepSettlement | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = input.assistantMessageID ?? SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata: boundedProviderMetadata(providerMetadata),
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: truncateText(value, MAX_DURABLE_TOOL_OUTPUT_BYTES),
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: {
    readonly id: string
    readonly name: string
    readonly providerMetadata?: ProviderMetadata
  }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
      providerMetadata: boundedProviderMetadata(event.providerMetadata),
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failAssistant = Effect.fnUntraced(function* (message: string) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    const boundedMessage = truncateText(message, MAX_DURABLE_TOOL_OUTPUT_BYTES)
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: { type: "unknown", message: boundedMessage },
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    const boundedMessage = truncateText(message, MAX_DURABLE_TOOL_OUTPUT_BYTES)
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message: boundedMessage },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        // Nothing durable opens here -- the assistant message is still lazy, waiting on the first
        // content frame. The flag is the record that the provider opened a step at all, which is
        // what tells a stream that ended without `step-finish` apart from one that never spoke.
        stepStarted = true
        return
      case "text-start":
        providerRetrySafe = false
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        yield* text.append(event.id, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID: event.id,
          delta: event.text,
        })
        return
      case "text-end":
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: boundedProviderMetadata(event.providerMetadata),
        })
        return
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          delta: event.text,
        })
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, boundedProviderMetadata(event.providerMetadata))
        return
      case "tool-input-start":
        providerRetrySafe = false
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        providerRetrySafe = false
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = boundedProviderMetadata(event.providerMetadata)
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: boundedRecord(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = boundedToolOutput(settledOutput(event.output, event.result))
        const metadata = boundedProviderMetadata(event.providerMetadata)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(metadata === undefined ? {} : { metadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: boundedToolResult(event.result),
            provider,
          })
          return
        }
        const compatibilityResult = provider.executed ? boundedToolResult(event.result, result) : undefined
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(compatibilityResult === undefined ? {} : { result: compatibilityResult }),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool error before input: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        const metadata = boundedProviderMetadata(event.providerMetadata)
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: truncateText(event.message, MAX_DURABLE_TOOL_OUTPUT_BYTES) },
          provider: {
            executed: tool.providerExecuted,
            ...(metadata === undefined ? {} : { metadata }),
          },
        })
        return
      }
      case "step-finish":
        providerRetrySafe = false
        yield* flush()
        assistantActive = false
        if (stepSettlement) return yield* Effect.die("Duplicate step finish")
        {
          // Both carry the provider's raw settlement payload; the event-level one
          // is the outer envelope and wins where a mapper sets both.
          const metadata = event.providerMetadata ?? event.usage?.providerMetadata
          stepSettlement = {
            finish: event.reason,
            tokens: tokens(event.usage),
            processed: processed(event.usage),
            ...(metadata === undefined ? {} : { metadata }),
          }
        }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant(event.message)
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasStepStarted: () => stepStarted,
    isProviderRetrySafe: () => providerRetrySafe,
    hasToolCalls: () => [...tools.values()].some((tool) => tool.called),
    hasProviderError: () => providerFailed,
    unsettledToolNames: () => [...tools.values()].filter((tool) => !tool.settled).map((tool) => tool.name),
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
