export * as SessionRunnerRetry from "./retry"

import { LLMError, isContextOverflowFailure, type ProviderErrorEvent } from "@turenlabs/llm"
import { ProviderShared } from "@turenlabs/llm/protocols"
import type { SessionEvent } from "../event"

/**
 * Session-level provider retry.
 *
 * This is the *user-visible* retry: it owns the waits a person is meant to see
 * and understand -- a rate limit that says "come back in 60 seconds", a
 * provider that is overloaded. It is deliberately layered above
 * `packages/llm/src/route/executor.ts`, whose retry is invisible and bounded to
 * ten seconds because its job is a different one: replaying a socket that never
 * delivered a response. Neither supersedes the other. What this layer adds is
 * the part the executor structurally cannot have -- a durable `Retried` event,
 * an attempt counter that survives the process, and a wait long enough to
 * actually clear a quota window.
 *
 * Every header name read here is a name `RequestExecutor` already parses off
 * real provider responses (`retry-after-ms`, `retry-after`), and the headers
 * themselves arrive pre-lowercased and pre-redacted on `LLMError.reason.http`.
 * Nothing is re-derived from a shape that was not observed on the wire.
 */

/** V1 parity: `packages/forge/src/session/retry.ts`. */
export const INITIAL_DELAY_MS = 2_000
export const BACKOFF_FACTOR = 2
/** Without a provider-supplied deadline, never wait longer than this. */
export const MAX_DELAY_WITHOUT_HEADERS_MS = 30_000
/** `setTimeout`'s ceiling; a larger delay silently fires immediately. */
export const MAX_DELAY_MS = 2_147_483_647
/**
 * V1 retried forever, which is how a session could sit in `retry` for an
 * afternoon with nothing in the transcript. The runner checklist asks for
 * provider retries to be bounded; eight attempts is long enough to ride out a
 * multi-minute quota window and short enough to terminate.
 */
export const MAX_ATTEMPTS = 8
/** Transport failures that remain after the executor get their own bounded retry budget. */
export const MAX_STREAM_ATTEMPTS = 3
/** Malformed provider frames may be transient, but repeated identical output should fail quickly. */
export const MAX_INVALID_OUTPUT_ATTEMPTS = 2

const cap = (ms: number, ceiling = MAX_DELAY_MS) => Math.min(Math.max(0, Math.ceil(ms)), ceiling)

/**
 * `Number("")` is `0` and `Number(" ")` is `0`, so a provider that sends an
 * empty `Retry-After` would otherwise be read as "retry immediately" -- which
 * is the one thing a rate limit is telling you not to do.
 */
const finiteNumber = (value: string | undefined) => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * `Retry-After` in both RFC 9110 forms: delta-seconds and an HTTP-date. The
 * `retry-after-ms` variant is Anthropic's and OpenAI's millisecond extension
 * and wins when present, matching `RequestExecutor`'s precedence exactly.
 */
export const retryAfterMs = (headers: Readonly<Record<string, string>> | undefined, now: number) => {
  if (!headers) return undefined
  const millis = finiteNumber(headers["retry-after-ms"])
  if (millis !== undefined) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (value === undefined) return undefined
  const seconds = finiteNumber(value)
  if (seconds !== undefined) return Math.max(0, seconds * 1000)

  const date = Date.parse(value.trim())
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

const backoff = (attempt: number) => INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attempt - 1))

/**
 * A provider deadline is honoured in full -- capping it to something shorter is
 * how you earn a second rate limit. Only the header-less fallback is clamped,
 * because there the number is a guess.
 */
export const delayFor = (input: {
  readonly attempt: number
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly fallbackRetryAfterMs?: number | undefined
  readonly now: number
  readonly jitter?: number
}) => {
  const explicit = retryAfterMs(input.headers, input.now) ?? input.fallbackRetryAfterMs
  if (explicit !== undefined) return cap(explicit)
  const spread = Number.isFinite(input.jitter) ? Math.min(1.25, Math.max(0.75, input.jitter ?? 1)) : 1
  if (input.headers) return cap(backoff(input.attempt) * spread)
  return cap(backoff(input.attempt) * spread, MAX_DELAY_WITHOUT_HEADERS_MS)
}

/** Stable per-Session spread prevents synchronized retries after a shared provider outage. */
export const jitterFor = (key: string, attempt: number) => {
  let hash = 2_166_136_261
  for (const character of `${key}:${attempt}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return 0.75 + ((hash >>> 0) % 501) / 1_000
}

const httpOf = (failure: LLMError) => ("http" in failure.reason ? failure.reason.http : undefined)

const statusOf = (failure: LLMError) => {
  const http = httpOf(failure)
  if (http?.response) return http.response.status
  if ("status" in failure.reason && typeof failure.reason.status === "number") return failure.reason.status
  return undefined
}

const inferredProviderRetryable = (failure: LLMError) => {
  if (failure.reason._tag !== "UnknownProvider") return false
  const status = statusOf(failure)
  if (status === 401 || status === 403) return false
  return ProviderShared.isTransientProviderError(undefined, `${status ?? ""} ${failure.reason.message}`)
}

const metadataOf = (failure: LLMError, provider: string | undefined) => {
  const entries: Record<string, string> = { reason: failure.reason._tag }
  if (provider) entries.provider = provider
  const requestID = httpOf(failure)?.requestId
  if (requestID) entries.requestId = requestID
  return entries
}

/**
 * Project an `LLMError` onto the durable `RetryError` shape. Headers and body
 * come straight off `RequestExecutor`'s capture of the real response, already
 * lowercased, size-bounded and secret-redacted, so the durable log carries what
 * the provider actually said rather than a paraphrase of it.
 */
export const toRetryError = (failure: LLMError, provider: string | undefined): SessionEvent.RetryError => {
  const http = httpOf(failure)
  return {
    message: failure.reason.message,
    ...(statusOf(failure) === undefined ? {} : { statusCode: statusOf(failure) }),
    isRetryable: failure.retryable,
    ...(http?.response ? { responseHeaders: http.response.headers } : {}),
    ...(http?.body === undefined ? {} : { responseBody: http.body }),
    metadata: metadataOf(failure, provider),
  }
}

const providerEventRetryError = (event: ProviderErrorEvent, provider: string | undefined): SessionEvent.RetryError => ({
  message: event.message,
  isRetryable: true,
  metadata: { reason: "ProviderStreamError", ...(provider ? { provider } : {}) },
})

export type Failure = LLMError | ProviderErrorEvent

const isProviderErrorEvent = (failure: Failure): failure is ProviderErrorEvent =>
  !(failure instanceof LLMError) && failure.type === "provider-error"

const providerEventRetryable = (event: ProviderErrorEvent) =>
  event.retryable === true ||
  (event.retryable !== false && ProviderShared.isTransientProviderError(undefined, event.message))

/**
 * Which `LLMError`s this layer takes responsibility for.
 *
 * RequestExecutor retries connection setup and status failures, but it no
 * longer owns the response after a 200 body starts streaming. Session retry
 * therefore handles transport failures that reach the runner, malformed
 * provider frames, and transient unknown provider responses, with smaller
 * budgets than explicit rate-limit/overload responses.
 */
const retryLimit = (failure: Failure) => {
  if (isProviderErrorEvent(failure)) return providerEventRetryable(failure) ? MAX_ATTEMPTS : undefined
  if (failure.reason._tag === "InvalidProviderOutput") return MAX_INVALID_OUTPUT_ATTEMPTS
  if (inferredProviderRetryable(failure)) return MAX_STREAM_ATTEMPTS
  if (!failure.retryable) return undefined
  if (failure.reason._tag === "Transport") return MAX_STREAM_ATTEMPTS
  if (failure.reason._tag === "RateLimit" || failure.reason._tag === "ProviderInternal") return MAX_ATTEMPTS
  return MAX_STREAM_ATTEMPTS
}

export type Decision = {
  readonly attempt: number
  readonly delay: number
  readonly error: SessionEvent.RetryError
  readonly action?: SessionEvent.RetryAction
}

/**
 * Whether `failure` is worth another provider attempt, and how long to wait.
 *
 * `QuotaExceeded` is deliberately excluded: an exhausted quota is not a wait,
 * it is a billing state, and the runner already routes it to `usageLimited`. A
 * context overflow is never retried here; compaction owns that recovery.
 *
 * `attempt` is the number of the attempt that just failed, so the returned
 * `attempt` is the one about to be scheduled.
 */
export const decide = (input: {
  readonly failure: Failure
  readonly attempt: number
  readonly now: number
  readonly provider?: string | undefined
  readonly maxAttempts?: number
  readonly jitter?: number
}): Decision | undefined => {
  if (isContextOverflowFailure(input.failure)) return undefined
  const policyLimit = retryLimit(input.failure)
  if (policyLimit === undefined) return undefined
  const maxAttempts = input.maxAttempts === undefined ? policyLimit : Math.min(policyLimit, input.maxAttempts)
  if (input.attempt >= maxAttempts) return undefined
  const next = input.attempt + 1

  if (isProviderErrorEvent(input.failure)) {
    if (!providerEventRetryable(input.failure)) return undefined
    return {
      attempt: next,
      delay: delayFor({ attempt: next, now: input.now, jitter: input.jitter }),
      error: providerEventRetryError(input.failure, input.provider),
    }
  }

  const failure = input.failure
  const error = toRetryError(failure, input.provider)
  return {
    attempt: next,
    delay: delayFor({
      attempt: next,
      headers: httpOf(failure)?.response?.headers,
      fallbackRetryAfterMs: failure.retryAfterMs,
      now: input.now,
      jitter: input.jitter,
    }),
    error:
      failure.reason._tag === "InvalidProviderOutput" || inferredProviderRetryable(failure)
        ? { ...error, isRetryable: true }
        : error,
  }
}
