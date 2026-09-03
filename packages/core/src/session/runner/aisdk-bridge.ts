import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3Message,
  type LanguageModelV3StreamPart,
  type LanguageModelV3ToolResultOutput,
  type JSONValue,
  type SharedV3ProviderOptions,
} from "@ai-sdk/provider"
import {
  FinishReason,
  AuthenticationReason,
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  LLMEvent,
  LLMRequest,
  ProviderInternalReason,
  ProviderMetadata,
  RateLimitReason,
  ToolResultValue,
  isContextOverflow,
  TransportReason,
  type Model,
  type ToolContent,
} from "@turenlabs/llm"
import { ProviderShared } from "@turenlabs/llm/protocols"
import { Endpoint, Protocol, Route, type RouteDefaultsInput, type TransportDef } from "@turenlabs/llm/route"
import { Effect, Schema, Stream } from "effect"
import { ModelV2 } from "../../model"

type Prepared = {
  readonly request: LLMRequest
}

const protocol = Protocol.make({
  id: "aisdk-language-model-v3",
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
    module: "AISDKBridge",
    method,
    reason: new TransportReason({
      message,
      kind: "ai-sdk-language-model-v3",
    }),
  })

const invalidOutput = (message: string, raw?: string, sanitize = (value: string) => value) =>
  new LLMError({
    module: "AISDKBridge",
    method: "stream",
    reason: new InvalidProviderOutputReason({
      message,
      route: "aisdk-language-model-v3",
      raw: raw === undefined ? undefined : sanitize(raw),
    }),
  })

const MAX_ERROR_TEXT = 512
const MAX_SECRET_LITERALS = 128
const MIN_SECRET_LENGTH = 8
const SENSITIVE_NAME =
  /(?:api[-_]?key|token|secret|password|credential|authorization|cookie|signature|access[-_]?key|private[-_]?key)/i

const errorSanitizer = (model: ModelV2.Info) => {
  const secrets = new Set<string>()
  const add = (value: string) => {
    if (value.length < MIN_SECRET_LENGTH || secrets.size >= MAX_SECRET_LITERALS) return
    const bounded = value.slice(0, 4_096)
    secrets.add(bounded)
    if (secrets.size < MAX_SECRET_LITERALS) secrets.add(encodeURIComponent(bounded))
    const authorization = bounded.match(/^(?:Basic|Bearer)\s+(.+)$/i)?.[1]
    if (authorization && authorization.length >= MIN_SECRET_LENGTH && secrets.size < MAX_SECRET_LITERALS)
      secrets.add(authorization)
  }
  const visit = (value: unknown, sensitive = false): void => {
    if (typeof value === "string") {
      if (sensitive) add(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, sensitive))
      return
    }
    if (!value || typeof value !== "object") return
    Object.entries(value).forEach(([key, item]) => visit(item, sensitive || SENSITIVE_NAME.test(key)))
  }

  Object.values(model.request.headers).forEach(add)
  visit(model.request.body)
  if (model.api.type === "aisdk") visit(model.api.settings)
  if (model.api.url) {
    const url = URL.parse(model.api.url)
    url?.searchParams.forEach((value, key) => {
      if (SENSITIVE_NAME.test(key)) add(value)
    })
  }
  const literals = [...secrets].sort((a, b) => b.length - a.length)
  return (value: string) => {
    const bounded = value.slice(0, MAX_ERROR_TEXT + (literals[0]?.length ?? 0))
    return literals.reduce((text, secret) => text.split(secret).join("[REDACTED]"), bounded).slice(0, MAX_ERROR_TEXT)
  }
}

const providerErrorMessage = (error: unknown, fallback: string) => {
  if (!APICallError.isInstance(error)) return fallback
  const status = error.statusCode
  if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) return fallback
  return `${fallback} with status ${status}`
}

const providerErrorText = (error: unknown, fallback: string, sanitize: (value: string) => string) => {
  const message = providerErrorMessage(error, fallback)
  if (!APICallError.isInstance(error) || !error.responseBody) return sanitize(message)
  return sanitize(`${message}: ${error.responseBody}`)
}

const jsonObject = (value: string | undefined) => {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export const retryableOpenAIStreamErrorCode = (error: unknown) => {
  const message = typeof error === "string" ? error.trim() : error instanceof Error ? error.message.trim() : undefined
  const body =
    jsonObject(APICallError.isInstance(error) ? error.responseBody : message) ??
    (error && typeof error === "object" ? (error as Record<string, unknown>) : undefined)
  const detail = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : body
  const structuredCode =
    typeof detail?.code === "string"
      ? detail.code
      : typeof detail?.type === "string" && detail.type !== "error"
        ? detail.type
        : undefined
  const prefix = /^([a-z][a-z0-9_]*)(?::|$)/i.exec(message ?? "")?.[1]
  const code = structuredCode ?? prefix
  const detailMessage = typeof detail?.message === "string" ? detail.message : (message ?? "")
  if (code) return ProviderShared.isTransientProviderError(code, "") ? code : undefined
  return ProviderShared.isTransientProviderError(undefined, detailMessage) ? "transient_error" : undefined
}

const retryAfterMs = (error: unknown) => {
  if (!APICallError.isInstance(error) || !error.responseHeaders) return undefined
  const headers = Object.fromEntries(
    Object.entries(error.responseHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  )
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)
  const value = headers["retry-after"]
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const classifiedAPICallFailure = (
  method: string,
  error: unknown,
  fallback: string,
  sanitize: (value: string) => string,
) => {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return undefined
  const status = error.statusCode
  const message = providerErrorText(error, fallback, sanitize)
  if (status === 401 || status === 403)
    return new LLMError({
      module: "AISDKBridge",
      method,
      reason: new AuthenticationReason({ message, kind: status === 403 ? "insufficient-permissions" : "invalid" }),
    })
  if (status === 429)
    return new LLMError({
      module: "AISDKBridge",
      method,
      reason: new RateLimitReason({ message, retryAfterMs: retryAfterMs(error) }),
    })
  if (status >= 500 || status === 408 || status === 425)
    return new LLMError({
      module: "AISDKBridge",
      method,
      reason: new ProviderInternalReason({ message, status, retryAfterMs: retryAfterMs(error) }),
    })
  if (status >= 400 && status < 500)
    return new LLMError({
      module: "AISDKBridge",
      method,
      reason: new InvalidRequestReason({
        message,
        classification: isContextOverflow(message) ? "context-overflow" : undefined,
      }),
    })
  return undefined
}

const streamFailure = (
  method: string,
  error: unknown,
  fallback: string,
  providerID: string,
  sanitize: (value: string) => string,
) => {
  const classified = classifiedAPICallFailure(method, error, fallback, sanitize)
  if (classified) return classified
  const code = providerID === "openai" ? retryableOpenAIStreamErrorCode(error) : undefined
  if (!code) return transportError(method, providerErrorText(error, fallback, sanitize))
  const message = sanitize(
    typeof error === "string" ? error : error instanceof Error ? error.message : providerErrorMessage(error, fallback),
  )
  return new LLMError({
    module: "AISDKBridge",
    method,
    reason:
      code.includes("rate_limit") ||
      code === "slow_down" ||
      (APICallError.isInstance(error) && error.statusCode === 429)
        ? new RateLimitReason({ message, retryAfterMs: retryAfterMs(error) })
        : new ProviderInternalReason({
            message,
            status:
              APICallError.isInstance(error) && error.statusCode !== undefined && error.statusCode >= 500
                ? error.statusCode
                : 500,
            retryAfterMs: retryAfterMs(error),
          }),
  })
}

const providerMetadata = (value: unknown) => (Schema.is(ProviderMetadata)(value) ? value : undefined)

const ProviderOptionsSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json))

const providerOptions = (value: unknown): SharedV3ProviderOptions | undefined =>
  Schema.is(ProviderOptionsSchema)(value) ? (value as unknown as SharedV3ProviderOptions) : undefined

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

type BridgeToolOutputItem = Extract<LanguageModelV3ToolResultOutput, { type: "content" }>["value"][number]

const toolContent = (item: ToolContent): Effect.Effect<BridgeToolOutputItem, LLMError> => {
  if (item.type === "text") return Effect.succeed({ type: "text", text: item.text })
  if (!item.uri.startsWith("data:"))
    return Effect.fail(invalidOutput("AI SDK bridge tool-result files must use immutable data URLs"))
  if (!MEDIA_TYPE.test(item.mime))
    return Effect.fail(invalidOutput("AI SDK bridge tool-result file has an invalid media type"))
  return ProviderShared.validateMedia(
    "AI SDK bridge",
    { type: "media", mediaType: item.mime, data: item.uri, filename: item.name },
    new Set([item.mime.toLowerCase()]),
  ).pipe(
    Effect.mapError(() => invalidOutput("AI SDK bridge tool-result file contains invalid or oversized data")),
    Effect.map((media) => ({
      type: "file-data",
      data: media.base64,
      mediaType: media.mime,
      filename: item.name,
    })),
  )
}

const toolOutput = (result: ToolResultValue): Effect.Effect<LanguageModelV3ToolResultOutput, LLMError> => {
  if (result.type === "text") return Effect.succeed({ type: "text", value: String(result.value) })
  if (result.type === "error") return Effect.succeed({ type: "error-text", value: String(result.value) })
  if (result.type === "json") {
    if (!Schema.is(Schema.Json)(result.value))
      return Effect.fail(invalidOutput("AI SDK bridge tool JSON output is not JSON serializable"))
    return Effect.succeed({ type: "json", value: result.value as unknown as JSONValue })
  }
  return Effect.forEach(result.value, toolContent).pipe(Effect.map((value) => ({ type: "content", value })))
}

type BridgeContentPart = Extract<LanguageModelV3Message, { role: "assistant" }>["content"][number]

const contentPart = (
  part: LLMRequest["messages"][number]["content"][number],
): Effect.Effect<BridgeContentPart, LLMError> => {
  if (part.type === "text")
    return Effect.succeed({
      type: "text",
      text: part.text,
      providerOptions: providerOptions(part.providerMetadata),
    })
  if (part.type === "media") {
    if (!MEDIA_TYPE.test(part.mediaType))
      return Effect.fail(invalidOutput("AI SDK bridge request file has an invalid media type"))
    return ProviderShared.validateMedia("AI SDK bridge", part, new Set([part.mediaType.toLowerCase()])).pipe(
      Effect.map((media) => ({
        type: "file",
        data: media.base64,
        mediaType: media.mime,
        filename: part.filename,
      })),
    )
  }
  if (part.type === "reasoning")
    return Effect.succeed({
      type: "reasoning",
      text: part.text,
      providerOptions: providerOptions(part.providerMetadata),
    })
  if (part.type === "tool-call")
    return Effect.succeed({
      type: "tool-call",
      toolCallId: part.id,
      toolName: part.name,
      input: part.input,
      providerExecuted: part.providerExecuted,
      providerOptions: providerOptions(part.providerMetadata),
    })
  return toolOutput(part.result).pipe(
    Effect.map((output) => ({
      type: "tool-result",
      toolCallId: part.id,
      toolName: part.name,
      output,
      providerOptions: providerOptions(part.providerMetadata),
    })),
  )
}

const message = Effect.fn("AISDKBridge.message")(function* (
  input: LLMRequest["messages"][number],
): Effect.fn.Return<LanguageModelV3Message, LLMError> {
  if (input.role === "system") {
    if (input.content.some((part) => part.type !== "text"))
      return yield* invalidOutput("AI SDK bridge system messages only support text parts")
    return {
      role: "system",
      content: input.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
      providerOptions: providerOptions(input.native?.providerOptions),
    }
  }

  const content = yield* Effect.forEach(input.content, contentPart)
  if (input.role === "user") {
    if (content.some((part) => part.type !== "text" && part.type !== "file"))
      return yield* invalidOutput("AI SDK bridge user messages only support text and immutable file parts")
    return {
      role: "user",
      content: content as Extract<LanguageModelV3Message, { role: "user" }>["content"],
      providerOptions: providerOptions(input.native?.providerOptions),
    }
  }
  if (input.role === "tool") {
    if (content.some((part) => part.type !== "tool-result"))
      return yield* invalidOutput("AI SDK bridge tool messages only support tool-result parts")
    return {
      role: "tool",
      content: content as Extract<LanguageModelV3Message, { role: "tool" }>["content"],
      providerOptions: providerOptions(input.native?.providerOptions),
    }
  }
  return {
    role: "assistant",
    content: content as Extract<LanguageModelV3Message, { role: "assistant" }>["content"],
    providerOptions: providerOptions(input.native?.providerOptions),
  }
})

const responseFormat = (request: LLMRequest): Effect.Effect<LanguageModelV3CallOptions["responseFormat"], LLMError> => {
  if (request.responseFormat === undefined || request.responseFormat.type === "text")
    return Effect.succeed({ type: "text" })
  if (request.responseFormat.type === "tool")
    return Effect.fail(invalidOutput("AI SDK bridge does not translate tool response formats"))
  return Effect.succeed({
    type: "json",
    schema: request.responseFormat.schema as Extract<
      NonNullable<LanguageModelV3CallOptions["responseFormat"]>,
      { type: "json" }
    >["schema"],
  })
}

const toolInputSchema = (
  input: LLMRequest["tools"][number]["inputSchema"],
): LanguageModelV3FunctionTool["inputSchema"] => {
  if (input.type !== undefined) return input as LanguageModelV3FunctionTool["inputSchema"]
  // Effect represents Schema.Struct({}) as an object-or-array union. Function calls are always keyed objects,
  // and Kimi's Anthropic-compatible endpoint rejects every request unless the root object type is explicit.
  return { ...input, type: "object" } as LanguageModelV3FunctionTool["inputSchema"]
}

const callOptions = Effect.fn("AISDKBridge.callOptions")(function* (
  request: LLMRequest,
  signal: AbortSignal,
): Effect.fn.Return<LanguageModelV3CallOptions, LLMError> {
  const prompt = [
    ...request.system.map(
      (part): LanguageModelV3Message => ({
        role: "system",
        content: part.text,
        providerOptions: providerOptions(part.metadata),
      }),
    ),
    ...(yield* Effect.forEach(request.messages, message)),
  ]
  const tools: LanguageModelV3FunctionTool[] = request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool.inputSchema),
    providerOptions: providerOptions(tool.native?.providerOptions),
  }))
  return {
    prompt,
    maxOutputTokens: request.generation?.maxTokens,
    temperature: request.generation?.temperature,
    stopSequences: request.generation?.stop ? [...request.generation.stop] : undefined,
    topP: request.generation?.topP,
    topK: request.generation?.topK,
    presencePenalty: request.generation?.presencePenalty,
    frequencyPenalty: request.generation?.frequencyPenalty,
    responseFormat: yield* responseFormat(request),
    seed: request.generation?.seed,
    tools: tools.length === 0 ? undefined : tools,
    toolChoice:
      request.toolChoice === undefined
        ? undefined
        : request.toolChoice.type === "tool"
          ? { type: "tool", toolName: request.toolChoice.name! }
          : { type: request.toolChoice.type },
    abortSignal: signal,
    headers: request.http?.headers,
    providerOptions: providerOptions(request.providerOptions),
  }
})

const usage = (value: Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"]) => ({
  inputTokens: value.inputTokens.total,
  outputTokens: value.outputTokens.total,
  nonCachedInputTokens: value.inputTokens.noCache,
  cacheReadInputTokens: value.inputTokens.cacheRead,
  cacheWriteInputTokens: value.inputTokens.cacheWrite,
  reasoningTokens: value.outputTokens.reasoning,
  totalTokens:
    value.inputTokens.total === undefined || value.outputTokens.total === undefined
      ? undefined
      : value.inputTokens.total + value.outputTokens.total,
})

const finishReason = (value: Extract<LanguageModelV3StreamPart, { type: "finish" }>["finishReason"]) =>
  Schema.is(FinishReason)(value.unified) ? value.unified : "unknown"

const streamEvent = (
  event: LanguageModelV3StreamPart,
  toolNames: Record<string, string>,
  sanitize: (value: string) => string,
  providerID: string,
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> => {
  switch (event.type) {
    case "stream-start":
      return Effect.succeed([LLMEvent.stepStart({ index: 0 })])
    case "response-metadata":
    case "raw":
      return Effect.succeed([])
    case "text-start":
      return Effect.succeed([
        LLMEvent.textStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "text-end":
      return Effect.succeed([
        LLMEvent.textEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-start":
      return Effect.succeed([
        LLMEvent.reasoningStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "reasoning-end":
      return Effect.succeed([
        LLMEvent.reasoningEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "tool-input-start":
      return Effect.sync(() => {
        toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })
    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: toolNames[event.id] ?? "unknown",
          text: event.delta,
        }),
      ])
    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-call":
      return Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(event.input).pipe(
        Effect.mapError(() => invalidOutput("AI SDK bridge received invalid tool-call JSON", event.input, sanitize)),
        Effect.map((input) => [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input,
            providerExecuted: event.providerExecuted,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]),
      )
    case "tool-result":
      if (event.preliminary)
        return Effect.fail(invalidOutput("AI SDK bridge does not expose preliminary provider tool results"))
      return Effect.succeed([
        LLMEvent.toolResult({
          id: event.toolCallId,
          name: event.toolName,
          result: ToolResultValue.make(event.result, event.isError ? "error" : "json"),
          providerExecuted: true,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "finish": {
      const reason = finishReason(event.finishReason)
      if (reason === "error") {
        const raw = typeof event.finishReason.raw === "string" ? sanitize(event.finishReason.raw.trim()) : ""
        return Effect.succeed([
          LLMEvent.providerError({
            message: raw ? `Provider response failed: ${raw}` : "Provider response failed",
            ...(providerID === "openai" && retryableOpenAIStreamErrorCode(raw) ? { retryable: true } : {}),
          }),
        ])
      }
      const tokens = usage(event.usage)
      const metadata = providerMetadata(event.providerMetadata)
      return Effect.succeed([
        LLMEvent.stepFinish({ index: 0, reason, usage: tokens, providerMetadata: metadata }),
        LLMEvent.finish({ reason, usage: tokens, providerMetadata: metadata }),
      ])
    }
    case "error": {
      const classified = classifiedAPICallFailure("stream", event.error, "Provider response stream failed", sanitize)
      if (classified) return Effect.fail(classified)
      const code = providerID === "openai" ? retryableOpenAIStreamErrorCode(event.error) : undefined
      if (code)
        return Effect.succeed([
          LLMEvent.providerError({
            message: code === "server_is_overloaded" ? "OpenAI servers are overloaded." : "OpenAI server error.",
            retryable: true,
          }),
        ])
      return Effect.fail(
        transportError("stream", providerErrorText(event.error, "Provider response stream failed", sanitize)),
      )
    }
    case "file":
    case "source":
      return Effect.succeed([])
    case "tool-approval-request":
      return Effect.fail(invalidOutput(`AI SDK bridge rejects unsupported provider event: ${event.type}`))
  }
}

const transport = (
  language: LanguageModelV3,
  sanitize: (value: string) => string,
  providerID: string,
): TransportDef<LLMRequest, Prepared, LLMEvent> => ({
  id: "aisdk-language-model-v3",
  prepare: (input) => Effect.succeed({ request: input.request }),
  frames: (prepared) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        )
        const options = yield* callOptions(prepared.request, controller.signal)
        const result = yield* Effect.tryPromise({
          try: () => language.doStream(options),
          catch: (error) => streamFailure("doStream", error, "Provider API request failed", providerID, sanitize),
        })
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => result.stream.getReader()),
          (reader) => Effect.promise(() => reader.cancel().catch(() => undefined)),
        )
        const toolNames: Record<string, string> = {}
        return Stream.unfold(reader, (reader) =>
          Effect.tryPromise({
            try: () => reader.read(),
            catch: (error) => streamFailure("read", error, "Provider response stream failed", providerID, sanitize),
          }).pipe(Effect.map((part) => (part.done ? undefined : ([part.value, reader] as const)))),
        ).pipe(
          Stream.mapEffect((event) => streamEvent(event, toolNames, sanitize, String(prepared.request.model.provider))),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        )
      }),
    ),
})

export const model = (input: {
  readonly language: LanguageModelV3
  readonly model: ModelV2.Info
  readonly defaults: RouteDefaultsInput
  readonly compatibility?: Model["compatibility"]
}) =>
  Route.make({
    id: "aisdk-language-model-v3",
    provider: input.model.providerID,
    protocol,
    endpoint: Endpoint.path("", { baseURL: "https://aisdk-transport.invalid" }),
    transport: transport(input.language, errorSanitizer(input.model), input.model.providerID),
    defaults: input.defaults,
  }).model({ id: input.model.api.id, compatibility: input.compatibility })

export * as AISDKBridge from "./aisdk-bridge"
