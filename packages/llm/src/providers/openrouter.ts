import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { ProviderID, type LLMEvent, type ModelID, type ProviderOptions, type ReasoningPart } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAIChat from "../protocols/openai-chat"
import { isRecord, JsonObject, optionalNull } from "../protocols/shared"
import { Lifecycle } from "../protocols/utils/lifecycle"

export const profile = OpenAICompatibleProfiles.profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

const OpenRouterBody = Schema.StructWithRest(Schema.Struct(OpenAIChat.bodyFields), [
  Schema.Record(Schema.String, Schema.Any),
])
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

// OpenRouter streams reasoning as `delta.reasoning` (plain text) plus `delta.reasoning_details`
// (typed blocks: `reasoning.text`, `reasoning.summary`, `reasoning.encrypted`), never as
// `reasoning_content`. The details are what OpenRouter needs back on the next assistant message
// to continue a reasoning chain across tool calls, so they are kept whole and opaque.
const OpenRouterEvent = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: optionalNull(
        Schema.Struct({
          ...OpenAIChat.deltaFields,
          reasoning: optionalNull(Schema.String),
          reasoning_details: optionalNull(Schema.Array(JsonObject)),
        }),
      ),
      finish_reason: optionalNull(Schema.String),
    }),
  ),
  usage: optionalNull(OpenAIChat.OpenAIChatUsage),
})
type OpenRouterEvent = Schema.Schema.Type<typeof OpenRouterEvent>
type ReasoningDetail = Record<string, unknown>

interface ParserState {
  readonly chat: OpenAIChat.ParserState
  readonly details: ReadonlyArray<ReasoningDetail>
}

const DETAILS_ID = "reasoning-details"

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: (request) =>
      OpenAIChat.fromRequestWith({ reasoningDetails })(request).pipe(
        Effect.map(
          (body) =>
            ({
              ...body,
              ...bodyOptions(request.providerOptions?.openrouter),
            }) as OpenRouterBody,
        ),
      ),
  },
  stream: {
    event: Protocol.jsonEvent(OpenRouterEvent),
    initial: (request): ParserState => ({ chat: OpenAIChat.protocol.stream.initial(request), details: [] }),
    step: (state: ParserState, event: OpenRouterEvent) =>
      OpenAIChat.step(state.chat, {
        ...event,
        choices: event.choices.map((choice) =>
          choice.delta
            ? {
                ...choice,
                delta: { ...choice.delta, reasoning_content: choice.delta.reasoning ?? choice.delta.reasoning_content },
              }
            : choice,
        ),
      }).pipe(
        Effect.map(
          ([chat, events]) =>
            [
              { chat, details: (event.choices[0]?.delta?.reasoning_details ?? []).reduce(appendDetail, state.details) },
              events,
            ] as const,
        ),
      ),
    onHalt: (state: ParserState) => {
      if (state.details.length === 0) return OpenAIChat.finishEvents(state.chat)
      // Details keep arriving after the visible reasoning block has closed (the signature comes
      // last, after text or tool calls start) or with no reasoning text at all (an encrypted-only
      // Gemini tool-call turn), so the whole ordered list goes on one text-less reasoning block
      // emitted when the stream ends.
      const events: LLMEvent[] = []
      const providerMetadata = { openrouter: { reasoning_details: state.details } }
      const lifecycle = Lifecycle.reasoningEnd(
        Lifecycle.reasoningStart(state.chat.lifecycle, events, DETAILS_ID, providerMetadata),
        events,
        DETAILS_ID,
        providerMetadata,
      )
      return [...events, ...OpenAIChat.finishEvents({ ...state.chat, lifecycle })]
    },
  },
})

// Streamed details arrive as chunks of one block: consecutive `reasoning.text` / `reasoning.summary`
// chunks with the same index concatenate their text, and the block keeps the first non-null value
// of every other field (the signature usually arrives only on the last chunk). Other types, such
// as `reasoning.encrypted`, arrive whole and are appended untouched.
const MERGED_FIELD: Record<string, string> = { "reasoning.text": "text", "reasoning.summary": "summary" }

const appendDetail = (details: ReadonlyArray<ReasoningDetail>, detail: ReasoningDetail) => {
  const last = details.at(-1)
  const field = typeof detail.type === "string" ? MERGED_FIELD[detail.type] : undefined
  if (last === undefined || field === undefined || last.type !== detail.type || last.index !== detail.index)
    return [...details, detail]
  const text = [last[field], detail[field]].filter((value): value is string => typeof value === "string")
  return [
    ...details.slice(0, -1),
    {
      ...detail,
      ...Object.fromEntries(Object.entries(last).filter((entry) => entry[1] !== null && entry[1] !== undefined)),
      ...(text.length === 0 ? {} : { [field]: text.join("") }),
    },
  ]
}

// Only reasoning this route produced carries `providerMetadata.openrouter`; core drops provider
// metadata from history written by another model, so details never reach a different upstream.
const reasoningDetails = (parts: ReadonlyArray<ReasoningPart>) =>
  parts.flatMap((part) => {
    const details = part.providerMetadata?.openrouter?.reasoning_details
    return Array.isArray(details) ? details.filter(isRecord) : []
  })

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  return {
    ...(openrouter.usage === true
      ? { usage: { include: true } }
      : isRecord(openrouter.usage)
        ? { usage: openrouter.usage }
        : {}),
    ...(isRecord(openrouter.reasoning) ? { reasoning: openrouter.reasoning } : {}),
    ...(typeof openrouter.promptCacheKey === "string" ? { prompt_cache_key: openrouter.promptCacheKey } : {}),
  }
}

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: profile.baseURL }),
  framing: Framing.sse,
  // OpenRouter commits response headers within about a second and then sends
  // `: OPENROUTER PROCESSING` comments several times a second while the model thinks, so two
  // silent minutes means the upstream is gone, not busy.
  defaults: { http: { idleTimeoutMs: 120_000 } },
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model
