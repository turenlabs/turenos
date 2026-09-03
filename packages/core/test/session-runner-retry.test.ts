import { describe, expect } from "bun:test"
import { InvalidProviderOutputReason, LLMError, LLMEvent, TransportReason, UnknownProviderReason } from "@turenlabs/llm"
import { SessionRunnerRetry } from "@turenlabs/core/session/runner/retry"
import { Effect } from "effect"
import { it } from "./lib/effect"
import {
  afterExecutorRetries,
  anthropicOverloaded,
  anthropicRateLimited,
  executorFailure,
  openaiQuotaExceeded,
} from "./lib/provider-failure"

// A fixed instant so the HTTP-date form of `Retry-After` is a deterministic distance away.
const now = Date.parse("2026-07-28T12:00:00.000Z")

describe("SessionRunnerRetry.retryAfterMs", () => {
  it.effect("reads the delta-seconds form", () =>
    Effect.sync(() => {
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after": "60" }, now)).toBe(60_000)
    }),
  )

  it.effect("reads the HTTP-date form", () =>
    Effect.sync(() => {
      // RFC 9110 IMF-fixdate. Both pre-existing implementations in this repository parse it --
      // `packages/forge/src/session/retry.ts` and `packages/llm/src/route/executor.ts` -- so a
      // session-level policy that did not would be a regression against V1 and against the
      // transport layer at once.
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after": "Tue, 28 Jul 2026 12:01:30 GMT" }, now)).toBe(90_000)
    }),
  )

  it.effect("never reports a deadline that has already passed as negative", () =>
    Effect.sync(() => {
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after": "Tue, 28 Jul 2026 11:59:00 GMT" }, now)).toBe(0)
    }),
  )

  it.effect("prefers the millisecond extension over the seconds form", () =>
    Effect.sync(() => {
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after-ms": "1500", "retry-after": "60" }, now)).toBe(1_500)
    }),
  )

  it.effect("ignores an empty header instead of reading it as retry-immediately", () =>
    Effect.sync(() => {
      // `Number("")` is 0. A provider that sends a blank `Retry-After` must not be read as
      // permission to hammer it.
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after-ms": "", "retry-after": "30" }, now)).toBe(30_000)
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after": "  " }, now)).toBeUndefined()
      expect(SessionRunnerRetry.retryAfterMs({ "retry-after": "soon" }, now)).toBeUndefined()
    }),
  )

  it.effect("reports nothing when the provider said nothing", () =>
    Effect.sync(() => {
      expect(SessionRunnerRetry.retryAfterMs(undefined, now)).toBeUndefined()
      expect(SessionRunnerRetry.retryAfterMs({}, now)).toBeUndefined()
    }),
  )
})

describe("SessionRunnerRetry.delayFor", () => {
  it.effect("backs off exponentially when the provider gave no deadline", () =>
    Effect.sync(() => {
      const delays = [1, 2, 3, 4].map((attempt) => SessionRunnerRetry.delayFor({ attempt, headers: {}, now }))
      expect(delays).toEqual([2_000, 4_000, 8_000, 16_000])
    }),
  )

  it.effect("clamps the header-less fallback", () =>
    Effect.sync(() => {
      expect(SessionRunnerRetry.delayFor({ attempt: 8, now })).toBe(SessionRunnerRetry.MAX_DELAY_WITHOUT_HEADERS_MS)
    }),
  )

  it.effect("honors a long provider deadline in full", () =>
    Effect.sync(() => {
      // The transport layer clamps `Retry-After` to ten seconds, which is right for a layer that
      // retries invisibly and wrong for one that can tell the user to wait. Shortening a deadline
      // the provider set is how a second rate limit is earned.
      expect(SessionRunnerRetry.delayFor({ attempt: 1, headers: { "retry-after": "600" }, now })).toBe(600_000)
    }),
  )

  it.effect("applies stable bounded jitter only to guessed backoff", () =>
    Effect.sync(() => {
      const first = SessionRunnerRetry.jitterFor("ses_first", 1)
      expect(first).toBeGreaterThanOrEqual(0.75)
      expect(first).toBeLessThanOrEqual(1.25)
      expect(SessionRunnerRetry.jitterFor("ses_first", 1)).toBe(first)
      expect(SessionRunnerRetry.delayFor({ attempt: 1, now, jitter: 0.75 })).toBe(1_500)
      expect(SessionRunnerRetry.delayFor({ attempt: 1, headers: { "retry-after": "60" }, now, jitter: 0.75 })).toBe(
        60_000,
      )
    }),
  )
})

describe("SessionRunnerRetry.decide", () => {
  it.effect("waits exactly as long as a real Anthropic 429 asked for", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited({ "retry-after": "60" })))

      expect(failure.reason._tag).toBe("RateLimit")
      const decision = SessionRunnerRetry.decide({ failure, attempt: 0, now, provider: "anthropic" })
      expect(decision).toMatchObject({ attempt: 1, delay: 60_000 })
      expect(decision?.error).toMatchObject({
        isRetryable: true,
        statusCode: 429,
        metadata: { provider: "anthropic", reason: "RateLimit", requestId: "req_011CSf9dJgnzxKCY2BC2Beh" },
      })
      // The durable record carries what the provider actually said, headers included, so the
      // desktop can explain the wait and an operator can audit it after the fact.
      expect(decision?.error.responseHeaders?.["retry-after"]).toBe("60")
      expect(decision?.error.responseHeaders?.["anthropic-ratelimit-requests-remaining"]).toBe("0")
      expect(decision?.error.responseBody).toContain("rate_limit_error")
      expect(decision?.error.message).toContain("429")
    }),
  )

  it.effect("honors the HTTP-date form on a real 429", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure(
        afterExecutorRetries(anthropicRateLimited({ "retry-after": "Tue, 28 Jul 2026 12:02:00 GMT" })),
      )

      expect(SessionRunnerRetry.decide({ failure, attempt: 0, now })).toMatchObject({ attempt: 1, delay: 120_000 })
    }),
  )

  it.effect("retries a real Anthropic 529 overload with backoff", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure(afterExecutorRetries(anthropicOverloaded()))

      expect(failure.reason._tag).toBe("ProviderInternal")
      expect(SessionRunnerRetry.decide({ failure, attempt: 0, now })).toMatchObject({ attempt: 1, delay: 2_000 })
      expect(SessionRunnerRetry.decide({ failure, attempt: 3, now })).toMatchObject({ attempt: 4, delay: 16_000 })
    }),
  )

  it.effect("does not retry an exhausted quota", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure(
        afterExecutorRetries(openaiQuotaExceeded()),
        "https://api.openai.com/v1/chat/completions",
      )

      // An exhausted quota is a billing state, not a wait: no amount of backoff clears it, and the
      // runner already routes it to a `usageLimited` goal.
      expect(failure.reason._tag).toBe("QuotaExceeded")
      expect(SessionRunnerRetry.decide({ failure, attempt: 0, now })).toBeUndefined()
    }),
  )

  it.effect("stops at the attempt bound", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure(afterExecutorRetries(anthropicRateLimited()))

      expect(SessionRunnerRetry.decide({ failure, attempt: SessionRunnerRetry.MAX_ATTEMPTS - 1, now })).toBeDefined()
      expect(SessionRunnerRetry.decide({ failure, attempt: SessionRunnerRetry.MAX_ATTEMPTS, now })).toBeUndefined()
    }),
  )

  it.effect("does not retry unknown provider failures", () =>
    Effect.gen(function* () {
      const failure = yield* executorFailure([new Response("nope", { status: 418 })])

      expect(failure.reason._tag).toBe("UnknownProvider")
      expect(SessionRunnerRetry.decide({ failure, attempt: 0, now })).toBeUndefined()
    }),
  )

  it.effect("bounds 200-body stream and malformed-frame retries separately", () =>
    Effect.sync(() => {
      const transport = new LLMError({
        module: "ProviderShared",
        method: "stream",
        reason: new TransportReason({ kind: "Stream", message: "Decode error" }),
      })
      const malformed = new LLMError({
        module: "ProviderShared",
        method: "stream",
        reason: new InvalidProviderOutputReason({ route: "openai-responses", message: "Malformed frame" }),
      })

      expect(SessionRunnerRetry.decide({ failure: transport, attempt: 0, now })).toMatchObject({
        attempt: 1,
        error: { isRetryable: true, metadata: { reason: "Transport" } },
      })
      expect(
        SessionRunnerRetry.decide({ failure: transport, attempt: SessionRunnerRetry.MAX_STREAM_ATTEMPTS, now }),
      ).toBeUndefined()
      expect(
        SessionRunnerRetry.decide({
          failure: new LLMError({
            module: "RequestExecutor",
            method: "execute",
            reason: new TransportReason({ kind: "Request", message: "Connection reset" }),
          }),
          attempt: 0,
          now,
          maxAttempts: 99,
        }),
      ).toMatchObject({ attempt: 1, error: { isRetryable: true } })
      expect(SessionRunnerRetry.decide({ failure: malformed, attempt: 0, now })).toMatchObject({
        attempt: 1,
        error: { isRetryable: true, metadata: { reason: "InvalidProviderOutput" } },
      })
      expect(
        SessionRunnerRetry.decide({
          failure: malformed,
          attempt: SessionRunnerRetry.MAX_INVALID_OUTPUT_ATTEMPTS,
          now,
        }),
      ).toBeUndefined()
      expect(SessionRunnerRetry.decide({ failure: malformed, attempt: 1, now, maxAttempts: 1 })).toBeUndefined()
    }),
  )

  it.effect("retries transient unknown provider and request transport failures", () =>
    Effect.sync(() => {
      const unknown = new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new UnknownProviderReason({ status: 502, message: "Network connection lost." }),
      })
      const transport = new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new TransportReason({ kind: "Request", message: "fetch failed: ECONNRESET" }),
      })

      expect(SessionRunnerRetry.decide({ failure: unknown, attempt: 0, now })).toMatchObject({
        attempt: 1,
        error: { isRetryable: true, statusCode: 502 },
      })
      expect(SessionRunnerRetry.decide({ failure: transport, attempt: 0, now })).toMatchObject({
        attempt: 1,
        error: { isRetryable: true },
      })
    }),
  )

  it.effect("retries a stream-level overload frame that never reached a status code", () =>
    Effect.sync(() => {
      // Anthropic delivers `overloaded_error` inside a 200 stream, so `RequestExecutor` never sees
      // it. Without this branch the most common overload signal of the busiest provider stays a
      // terminal failure.
      const event = LLMEvent.providerError({ message: "overloaded_error: Overloaded", retryable: true })
      expect(SessionRunnerRetry.decide({ failure: event, attempt: 0, now })).toMatchObject({
        attempt: 1,
        delay: 2_000,
        error: { isRetryable: true, message: "overloaded_error: Overloaded" },
      })
      expect(
        SessionRunnerRetry.decide({
          failure: LLMEvent.providerError({ message: "bad request", retryable: false }),
          attempt: 0,
          now,
        }),
      ).toBeUndefined()
      expect(
        SessionRunnerRetry.decide({
          failure: LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
          attempt: 0,
          now,
        }),
      ).toBeUndefined()
    }),
  )
})
