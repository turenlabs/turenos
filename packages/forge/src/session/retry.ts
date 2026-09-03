import type { NamedError } from "@turenlabs/core/util/error"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
import { ProviderShared } from "@turenlabs/llm/protocols"

export type Err = ReturnType<NamedError["toObject"]>

export type RetryReason = string & {}

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

const nonRetryableLimitEnvelope = (value: string | undefined) => {
  const body = parseJSON(value)
  const detail = isRecord(body?.error) ? body.error : body
  const code =
    typeof detail?.code === "string" ? detail.code : typeof detail?.type === "string" ? detail.type : undefined
  return (
    (code !== undefined &&
      /(?:quota|rate(?:[_ -])?limit|concurrency(?:[_ -])?limit|too(?:[_ -])many(?:[_ -])requests|slow(?:[_ -])down)/i.test(
        code,
      )) ||
    ((body?.type === "error" || body?.error !== undefined) &&
      /quota|rate(?:[_ -])?limit|concurrency(?:[_ -])?limit|too(?:[_ -])many(?:[_ -])requests|slow(?:[_ -])down/i.test(
        JSON.stringify(body),
      ))
  )
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, _provider: string): Retryable | undefined {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    const text = `${error.data.message} ${error.data.responseBody ?? ""}`
    const json = parseJSON(error.data.responseBody)
    if (json && typeof json === "object" && json.type === "error" && json.error?.type === "too_many_requests") {
      return { message: "Too Many Requests" }
    }
    if (nonRetryableLimitEnvelope(error.data.responseBody)) return undefined
    if (ProviderShared.isPermanentProviderError(undefined, text)) return undefined
    const retryableClientStatus = status === 408 || status === 425 || status === 429
    if (status !== undefined && status >= 400 && status < 500 && !retryableClientStatus) return undefined
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !retryableClientStatus &&
      !(status !== undefined && status >= 500) &&
      !ProviderShared.isTransientProviderError(undefined, text)
    )
      return undefined
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const msg = isRecord(error.data) ? error.data.message : undefined
  const json = parseJSON(msg)
  if (json && typeof json === "object") {
    const detail = isRecord(json.error) ? json.error : json
    const code = typeof detail.code === "string" ? detail.code : typeof json.code === "string" ? json.code : ""
    const detailMessage = typeof detail.message === "string" ? detail.message : typeof msg === "string" ? msg : code

    if (ProviderShared.isPermanentProviderError(code, detailMessage)) return undefined
    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return { message: "Too Many Requests" }
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return { message: "Provider is overloaded" }
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return { message: "Rate Limited" }
    }
    if (ProviderShared.isTransientProviderError(code, detailMessage)) return { message: msg ?? code }
  }
  if (typeof msg === "string") {
    if (ProviderShared.isPermanentProviderError(undefined, msg)) return undefined
    if (ProviderShared.isTransientProviderError(undefined, msg)) return { message: msg }
  }
  return undefined
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
