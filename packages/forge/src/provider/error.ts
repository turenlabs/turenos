import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@turenlabs/core/provider"
import { isContextOverflow, LLMError } from "@turenlabs/llm"
import { ProviderShared } from "@turenlabs/llm/protocols"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // OpenAI sometimes returns 404 for models that are actually available, but
  // a provider-marked 400/401/403 must not override deterministic HTTP status.
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500
}

const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `forge auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      const result: unknown = JSON.parse(input)
      if (result && typeof result === "object") return result as Record<string, unknown>
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>
  }
  return undefined
}

function embeddedJson(input: string) {
  const direct = json(input)
  if (direct) return direct
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  return json(input.slice(start, end + 1))
}

function statusCode(...values: unknown[]) {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
  )
}

function stringRecord(input: unknown) {
  const value = json(input)
  if (!value) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, item]) => typeof item === "string")) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

const isLimitCode = (code: string | undefined) =>
  code !== undefined &&
  /^(?:insufficient[_-]?quota|usage[_-]?not[_-]?included|(?:billing|free[_-]?usage|go[_-]?usage|quota)[_-]?(?:hard[_-]?limit|exceeded|exhausted|limit)?|rate[_-]?limit(?:[_-]?error|[_-]?exceeded)?|concurrency[_-]?limit[_-]?exceeded|too[_-]?many[_-]?requests|slow[_-]?down)$/i.test(
    code,
  )

const isLimitEnvelope = (body: Record<string, unknown> | undefined, code: string | undefined) => {
  if (isLimitCode(code)) return true
  if (!body || (body.type !== "error" && body.error === undefined)) return false
  return /quota|rate(?:[_ -])?limit|concurrency(?:[_ -])?limit|too(?:[_ -])many(?:[_ -])requests|slow(?:[_ -])down/i.test(
    JSON.stringify(body),
  )
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
      statusCode?: number
      responseHeaders?: Record<string, string>
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  if (input instanceof LLMError) {
    const http = "http" in input.reason ? input.reason.http : undefined
    const responseBody =
      http?.body ??
      (input.reason._tag === "RateLimit"
        ? JSON.stringify({ type: "error", error: { code: "rate_limit_error", message: input.reason.message } })
        : JSON.stringify({ type: "error", error: { message: input.reason.message } }))
    const statusCode = http?.response?.status ?? ("status" in input.reason ? input.reason.status : undefined)
    const responseHeaders = http?.response?.headers
    if (input.reason._tag === "InvalidRequest" && input.reason.classification === "context-overflow") {
      return {
        type: "context_overflow",
        message: input.reason.message,
        responseBody,
      }
    }
    return {
      type: "api_error",
      message: input.reason.message,
      isRetryable: input.reason._tag === "RateLimit" ? false : input.retryable,
      responseBody,
      statusCode,
      responseHeaders,
    }
  }

  const raw = json(input)
  const rawMessage =
    typeof input === "string"
      ? input.trim()
      : input instanceof Error
        ? input.message.trim()
        : typeof raw?.message === "string"
          ? raw.message.trim()
          : undefined
  const body = rawMessage ? (embeddedJson(rawMessage) ?? raw) : raw
  const detail = json(body?.error) ?? body
  const responseStatus = statusCode(
    detail?.status,
    detail?.statusCode,
    detail?.code,
    body?.status,
    body?.statusCode,
    body?.code,
    json(body?.response)?.status,
    json(body?.response)?.statusCode,
    raw?.status,
    raw?.statusCode,
    raw?.code,
  )
  const responseHeaders = stringRecord(body?.responseHeaders ?? body?.headers ?? raw?.responseHeaders ?? raw?.headers)
  const code =
    typeof detail?.code === "string"
      ? detail.code
      : typeof detail?.type === "string" && detail.type !== "error"
        ? detail.type
        : /^([a-z][a-z0-9_]*)(?::|$)/i.exec(rawMessage ?? "")?.[1]
  const detailMessage = typeof detail?.message === "string" ? detail.message : (code ?? rawMessage)
  const responseBody =
    body?.type === "error"
      ? JSON.stringify(body)
      : JSON.stringify({ type: "error", error: { ...(code ? { code } : {}), message: detailMessage } })

  switch (code) {
    case "context_length_exceeded":
    case "context_window_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: detailMessage ?? "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "billing_hard_limit_reached":
    case "free_usage_limit":
    case "go_usage_limit":
    case "quota_exceeded":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
  }

  if (isLimitEnvelope(body, code)) {
    return {
      type: "api_error",
      message: detailMessage ?? "Provider limit reached.",
      isRetryable: false,
      responseBody,
      statusCode: responseStatus,
      responseHeaders,
    }
  }

  const providerEnvelope =
    code !== undefined || responseStatus !== undefined || body?.type === "error" || body?.error !== undefined
  const detailText = detailMessage ?? ""
  const transient =
    (responseStatus !== undefined &&
      (responseStatus === 408 || responseStatus === 425 || responseStatus === 429 || responseStatus >= 500)) ||
    ProviderShared.isTransientProviderError(code, `${detailText} ${JSON.stringify(body ?? {})}`)
  if (!detailMessage || (!providerEnvelope && !transient)) return undefined
  return {
    type: "api_error",
    message: detailMessage,
    isRetryable: transient && !ProviderShared.isPermanentProviderError(code, `${detailText} ${responseBody}`),
    responseBody,
    statusCode: responseStatus,
    responseHeaders,
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isContextOverflow(m) || input.error.statusCode === 413 || json(body?.error)?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  const transient =
    (input.error.statusCode !== undefined &&
      (input.error.statusCode === 408 ||
        input.error.statusCode === 425 ||
        input.error.statusCode === 429 ||
        input.error.statusCode >= 500)) ||
    ProviderShared.isTransientProviderError(undefined, `${m} ${input.error.responseBody ?? ""}`)
  const permanent = ProviderShared.isPermanentProviderError(undefined, `${m} ${input.error.responseBody ?? ""}`)
  const errorBody = json(body?.error)
  const limitEnvelope = isLimitEnvelope(
    body,
    typeof errorBody?.code === "string"
      ? errorBody.code
      : typeof errorBody?.type === "string"
        ? errorBody.type
        : undefined,
  )
  const retryable =
    permanent || limitEnvelope
      ? false
      : input.error.statusCode === undefined
        ? input.error.isRetryable || transient
        : retryableStatus(input.error.statusCode)
  const openAiRetryable =
    input.error.statusCode === undefined ? input.error.isRetryable || transient : isOpenAiErrorRetryable(input.error)
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable:
      permanent || limitEnvelope ? false : input.providerID.startsWith("openai") ? openAiRetryable : retryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
