import { Buffer } from "node:buffer"
import { Effect, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import {
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  TransportReason,
  type ContentPart,
  type LLMRequest,
  type MediaPart,
  type ToolFileContent,
  type TextPart,
  type ToolResultPart,
} from "../schema"
import { isRecord } from "../utils/record"
export { isRecord }

export const Json = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownSync(Json)
export const encodeJson = Schema.encodeSync(Json)
const isJson = Schema.is(Schema.Json)
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export const optionalArray = <const S extends Schema.Top>(schema: S) => Schema.optional(Schema.Array(schema))
export const optionalNull = <const S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

/**
 * Streaming tool-call accumulator. Adapters that build a tool call across
 * multiple `tool-input-delta` chunks store the partial JSON input string here
 * and finalize it with `parseToolInput` once the call completes.
 */
export interface ToolAccumulator {
  readonly id: string
  readonly name: string
  readonly input: string
}

/**
 * `Usage.totalTokens` policy shared by every route. Honors a provider-
 * supplied total; otherwise falls back to `inputTokens + outputTokens` only
 * when at least one is defined. Returns `undefined` when neither input nor
 * output is known so routes don't publish a misleading `0`.
 *
 * Under the additive `LLM.Usage` contract, `inputTokens` and `outputTokens`
 * are the non-cached input and visible output only. The provider-supplied
 * `total` is the source of truth when present; the computed fallback
 * under-counts cache and reasoning by design and exists mainly so
 * Anthropic-style providers (which don't surface a total) still get a
 * sensible aggregate on the input + output axes.
 */
export const totalTokens = (
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  total: number | undefined,
) => {
  if (total !== undefined) return total
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return (inputTokens ?? 0) + (outputTokens ?? 0)
}

/**
 * Subtract `subtrahend` from `total`, clamping to zero if the provider
 * reports a non-sensical breakdown (e.g. `cached_tokens > prompt_tokens`).
 * Used by protocol mappers when deriving a non-overlapping breakdown field
 * from a provider's inclusive total — `nonCachedInputTokens` from
 * `inputTokens - cacheReadInputTokens - cacheWriteInputTokens`.
 *
 * If `total` is `undefined`, returns `undefined` (we don't fabricate
 * counts). If `subtrahend` is `undefined`, returns `total` unchanged. The
 * provider-native breakdown stays available on `Usage.native` for debugging.
 */
export const subtractTokens = (total: number | undefined, subtrahend: number | undefined): number | undefined => {
  if (total === undefined) return undefined
  if (subtrahend === undefined) return total
  return Math.max(0, total - subtrahend)
}

/**
 * Sum a list of optional token counts, returning `undefined` only when
 * every value is `undefined` (so we don't fabricate a `0`). Used by
 * protocol mappers to derive the inclusive `inputTokens` total from a
 * provider that natively reports a non-overlapping breakdown
 * (e.g. Anthropic, whose `input_tokens` is already non-cached only).
 */
export const sumTokens = (...values: ReadonlyArray<number | undefined>): number | undefined => {
  if (values.every((value) => value === undefined)) return undefined
  return values.reduce((acc: number, value) => acc + (value ?? 0), 0)
}

export const eventError = (route: string, message: string, raw?: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "stream",
    reason: new InvalidProviderOutputReason({ route, message, raw }),
  })

/** Keep transport failures distinct from malformed provider frames. */
/**
 * The whole story an error can tell, not just its own message.
 *
 * The useful part of a failure is usually one link down: `fetch failed` says
 * nothing while `fetch failed: ECONNRESET` says everything, and a schema
 * `Decode error` is worthless without the field that failed. Duplicate links
 * are skipped so a wrapper that copies its cause's message does not stutter,
 * and `seen` stops a self-referential chain.
 */
export const describeError = (error: unknown): string => {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    // Deliberately not `errorText`: its fallback is worded for stream failures
    // and would label an arbitrary value as one.
    const text =
      current instanceof Error
        ? current.message
        : typeof current === "string" ||
            typeof current === "number" ||
            typeof current === "boolean" ||
            typeof current === "bigint"
          ? String(current)
          : ""
    if (text && !parts.includes(text)) parts.push(text)
    const code = current instanceof Error ? (current as { code?: unknown }).code : undefined
    if (typeof code === "string" && !parts.includes(code)) parts.push(code)
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
  }
  return parts.length > 0 ? parts.join(": ") : "unknown error"
}

export const streamError = (route: string, message: string, detail?: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "stream",
    reason: new TransportReason({
      kind: "Stream",
      message: detail ? `${message}: ${detail}` : message,
    }),
  })

export const parseJson = (route: string, input: string, message: string) =>
  Effect.try({
    try: () => decodeJson(input),
    catch: () => eventError(route, message, input),
  })

/**
 * Join the `text` field of a list of parts with newlines. Used by routes
 * that flatten system / message content arrays into a single provider string
 * (OpenAI Chat `system` content, OpenAI Responses `system` content, Gemini
 * `systemInstruction.parts[].text`).
 */
export const joinText = (parts: ReadonlyArray<{ readonly text: string }>) => parts.map((part) => part.text).join("\n")

const escapeSystemUpdateText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/**
 * Stable fallback representation for chronological `Message.system(...)`
 * updates on routes that do not support that privileged role natively. The
 * wrapper remains visibly lower-authority user text, preserves the original
 * temporal position, and XML-escapes content so it cannot close the wrapper.
 */
export const wrapSystemUpdate = (parts: ReadonlyArray<{ readonly text: string }>) =>
  `<system-update>\n${escapeSystemUpdateText(joinText(parts))}\n</system-update>`

/**
 * Chronological system updates deliberately accept text only. Do not insert
 * raw retrieved, tool, or web content into privileged updates: keep untrusted
 * data in ordinary user/tool messages instead.
 */
export const systemUpdateText = Effect.fn("ProviderShared.systemUpdateText")(function* (
  route: string,
  message: LLMRequest["messages"][number],
) {
  const content: TextPart[] = []
  for (const part of message.content) {
    if (!supportsContent(part, ["text"])) return yield* unsupportedContent(route, "system", ["text"])
    content.push(part)
  }
  return content
})

/** Lower an unsupported privileged update into visible, in-order user text. */
export const wrappedSystemUpdate = Effect.fn("ProviderShared.wrappedSystemUpdate")(function* (
  route: string,
  message: LLMRequest["messages"][number],
) {
  const content = yield* systemUpdateText(route, message)
  return { type: "text" as const, text: wrapSystemUpdate(content), cache: content.at(-1)?.cache }
})

/**
 * Parse the streamed JSON input of a tool call. Treats an empty string as
 * `"{}"` — providers occasionally finish a tool call without ever emitting
 * input deltas (e.g. zero-arg tools). The error message is uniform across
 * routes: `Invalid JSON input for <route> tool call <name>`.
 */
export const parseToolInput = (route: string, name: string, raw: string) =>
  parseJson(route, raw || "{}", `Invalid JSON input for ${route} tool call ${name}`)

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"] as const
export const AUDIO_MIMES = ["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"] as const
export const MEDIA_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES, ...AUDIO_MIMES] as const
export const MAX_MEDIA_ENCODED_BYTES = 28 * 1024 * 1024
export const MAX_MEDIA_DECODED_BYTES = 20 * 1024 * 1024

export interface ValidatedMedia {
  readonly mime: string
  readonly base64: string
  readonly dataUrl: string
  readonly bytes: Uint8Array
}

export const validateMedia = Effect.fn("ProviderShared.validateMedia")(function* (
  route: string,
  part: MediaPart,
  supportedMimes: ReadonlySet<string>,
) {
  const mime = part.mediaType.toLowerCase()
  if (!supportedMimes.has(mime)) return yield* invalidRequest(`${route} does not support media type ${part.mediaType}`)

  let base64: string
  if (typeof part.data !== "string") {
    if (part.data.byteLength > MAX_MEDIA_DECODED_BYTES)
      return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
    base64 = Buffer.from(part.data).toString("base64")
  } else if (part.data.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.data)
    if (!match) return yield* invalidRequest(`${route} media data URL must contain valid base64`)
    if (match[1]!.toLowerCase() !== mime)
      return yield* invalidRequest(`${route} media type ${part.mediaType} does not match data URL type ${match[1]}`)
    base64 = match[2]!
  } else {
    base64 = part.data
  }

  if (Buffer.byteLength(base64, "utf8") > MAX_MEDIA_ENCODED_BYTES)
    return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`)
  if (!hasBase64Shape(base64))
    return yield* invalidRequest(`${route} media must contain valid base64`)
  const bytes = Buffer.from(base64, "base64")
  if (bytes.byteLength > MAX_MEDIA_DECODED_BYTES)
    return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
  if (bytes.toString("base64") !== base64) return yield* invalidRequest(`${route} media must contain canonical base64`)
  return { mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes } satisfies ValidatedMedia
})

function hasBase64Shape(value: string) {
  if (value.length === 0 || value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const contentLength = value.length - padding
  for (let i = 0; i < contentLength; i++) {
    const code = value.charCodeAt(i)
    if (
      (code < 48 || code > 57) &&
      (code < 65 || code > 90) &&
      (code < 97 || code > 122) &&
      code !== 43 &&
      code !== 47
    )
      return false
  }
  return true
}

export const validateToolFile = (route: string, part: ToolFileContent, supportedMimes: ReadonlySet<string>) =>
  validateMedia(route, { type: "media", mediaType: part.mime, data: part.uri, filename: part.name }, supportedMimes)

export const trimBaseUrl = (value: string) => value.replace(/\/+$/, "")

export const toolResultText = (part: ToolResultPart) => {
  if (part.result.type === "text") return String(part.result.value)
  if (part.result.type === "error") {
    const value = part.result.value
    const prototype =
      typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value)
    const structured = Array.isArray(value) || prototype === Object.prototype || prototype === null
    return structured && isJson(value) ? encodeJson(value) : String(value)
  }
  return encodeJson(part.result.value)
}

export const errorText = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error)
  if (error === null) return "null"
  if (error === undefined) return "undefined"
  return "Unknown stream error"
}

/**
 * `framing` step for Server-Sent Events. Decodes UTF-8, runs the SSE channel
 * decoder, and drops empty / `[DONE]` keep-alive events so the downstream
 * `decodeChunk` sees one JSON string per element. The SSE channel emits a
 * `Retry` control event on its error channel; we drop it here (we don't
 * implement client-driven retries) so the public error channel stays
 * `LLMError`.
 */
export const sseFraming = (bytes: Stream.Stream<Uint8Array, LLMError>): Stream.Stream<string, LLMError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.catchTag("Retry", () => Stream.empty),
    Stream.filter((event) => event.data.length > 0 && event.data !== "[DONE]"),
    Stream.map((event) => event.data),
  )

/**
 * Canonical invalid-request constructor. Lift one-line `const invalid =
 * (message) => invalidRequest(message)` aliases out of every
 * route so the error constructor lives in one place. If we ever extend
 * `InvalidRequestReason` with route context or trace metadata, the change
 * lands here.
 */
export const invalidRequest = (message: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "request",
    reason: new InvalidRequestReason({ message }),
  })

export const matchToolChoice = <Auto, None, Required, Tool>(
  route: string,
  toolChoice: NonNullable<LLMRequest["toolChoice"]>,
  cases: {
    readonly auto: () => Auto
    readonly none: () => None
    readonly required: () => Required
    readonly tool: (name: string) => Tool
  },
) =>
  Effect.gen(function* () {
    if (toolChoice.type === "auto") return cases.auto()
    if (toolChoice.type === "none") return cases.none()
    if (toolChoice.type === "required") return cases.required()
    if (!toolChoice.name) return yield* invalidRequest(`${route} tool choice requires a tool name`)
    return cases.tool(toolChoice.name)
  })

type ContentType = ContentPart["type"]

const formatContentTypes = (types: ReadonlyArray<ContentType>) => {
  if (types.length <= 1) return types[0] ?? ""
  if (types.length === 2) return `${types[0]} and ${types[1]}`
  return `${types.slice(0, -1).join(", ")}, and ${types.at(-1)}`
}

export const supportsContent = <const Type extends ContentType>(
  part: ContentPart,
  types: ReadonlyArray<Type>,
): part is Extract<ContentPart, { readonly type: Type }> => (types as ReadonlyArray<ContentType>).includes(part.type)

export const unsupportedContent = (
  route: string,
  role: LLMRequest["messages"][number]["role"],
  types: ReadonlyArray<ContentType>,
) => invalidRequest(`${route} ${role} messages only support ${formatContentTypes(types)} content for now`)

/**
 * Build a `validate` step from a Schema decoder. Replaces the per-route
 * lambda body `(payload) => decode(payload).pipe(Effect.mapError((e) =>
 * invalid(e.message)))`. Any decode error is translated into
 * `LLMError` carrying the original parse-error message.
 */
export const validateWith =
  <A, I, E extends { readonly message: string }>(decode: (input: I) => Effect.Effect<A, E>) =>
  (payload: I) =>
    decode(payload).pipe(Effect.mapError((error) => invalidRequest(error.message)))

/**
 * Build an HTTP POST with a JSON body. Sets `content-type: application/json`
 * automatically after caller-supplied headers so routes cannot accidentally
 * send JSON with a stale content type. The body is passed pre-encoded so
 * routes can choose between
 * `Schema.encodeSync(payload)` and `ProviderShared.encodeJson(payload)`.
 */
export const jsonPost = (input: { readonly url: string; readonly body: string; readonly headers?: Headers.Input }) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.setHeaders(Headers.set(Headers.fromInput(input.headers), "content-type", "application/json")),
    HttpClientRequest.bodyText(input.body, "application/json"),
  )

/**
 * In-stream error frames arrive on a 200, so `RequestExecutor`'s HTTP-status
 * retry never sees them. Provider parsers mark known transient conditions and
 * the runner uses this classifier as a fallback for flattened frames.
 */
const PERMANENT_ERROR_CODES = new Set([
  "authentication_error",
  "content_policy_violation",
  "context_length_exceeded",
  "billing_hard_limit_reached",
  "free_usage_limit",
  "insufficient_quota",
  "invalid_prompt",
  "invalid_request_error",
  "quota_exceeded",
  "usage_not_included",
  "go_usage_limit",
])

const PERMANENT_ERROR_PATTERNS = [
  /access denied|authentication(?:[_ -]error)?|invalid[_ -]?api[_ -]?key|invalid key|missing (?:api )?key|not[_ -]?authorized|permission[_ -]?denied|unauthorized|forbidden/i,
  /content[_ -]?policy|content[_ -]?filter|safety violation/i,
  /context(?:[_ -]length)?(?:[_ -]window)?[_ -]?exceeded|prompt is too long|input exceeds the context/i,
  /insufficient[_ -]?quota|usage[_ -]?not[_ -]?included|quota(?:[_ -](?:exceeded|exhausted))?|billing[_ -]?hard[_ -]?limit|free[_ -]?usage[_ -]?limit|go[_ -]?usage[_ -]?limit/i,
  /invalid[_ -]?request|invalid[_ -]?prompt|unsupported (?:parameter|option|media|content)/i,
]

const TRANSIENT_ERROR_CODES = new Set([
  "api_error",
  "concurrency_limit_exceeded",
  "fetch_error",
  "internal_server_error",
  "overloaded_error",
  "overloaded",
  "provider_unavailable",
  "rate_limit_error",
  "rate_limit_exceeded",
  "resource_exhausted",
  "server_error",
  "server_is_overloaded",
  "service_unavailable_error",
  "slow_down",
  "stream_read_error",
  "timeout",
  "unavailable",
  "upstream_error",
])

const TRANSIENT_ERROR_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate[-_ ]limit|too many requests/i,
  /overloaded|service[-_ ]unavailable|internal (?:server )?error|server[-_ ]error|provider[-_ ]returned[-_ ]error/i,
  /connection (?:error|refused|reset|lost)|fetch failed|failed to fetch|network error|upstream connect|socket (?:connection )?closed|socket hang up|terminated|other side closed|reset before headers|getaddrinfo|enotfound|eai_again|econnaborted|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe/i,
  /\b(?:timeout|timed out|time out)\b/i,
  /enginecore|try (?:your )?request again|retry (?:your )?request|try again later|resource[_ -]?exhausted/i,
]

export const isPermanentProviderError = (code: string | undefined, message: string): boolean => {
  const normalizedCode = code?.trim().toLowerCase()
  if (normalizedCode && PERMANENT_ERROR_CODES.has(normalizedCode)) return true
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(`${normalizedCode ?? ""} ${message}`))
}

export const isTransientProviderError = (code: string | undefined, message: string): boolean => {
  if (isPermanentProviderError(code, message)) return false
  const normalizedCode = code?.trim().toLowerCase()
  if (normalizedCode && TRANSIENT_ERROR_CODES.has(normalizedCode)) return true
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(`${normalizedCode ?? ""} ${message}`))
}

export * as ProviderShared from "./shared"
