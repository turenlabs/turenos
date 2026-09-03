import type { LLMError } from "@turenlabs/llm"
import { RequestExecutor } from "@turenlabs/llm/route"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

/**
 * Turn a provider HTTP response into the `LLMError` production would see.
 *
 * Retry is a wire-shape problem, and this repository has no recorded 429 to
 * replay -- `http-recorder` allowlists response headers down to `content-type`,
 * so even the cassettes that exist would have dropped `retry-after` on the
 * floor. So rather than hand-building an `LLMError` and hoping its fields match
 * what a provider produces, these helpers hand a `Response` to the real
 * `RequestExecutor` and keep whatever it makes of it: the status mapping, the
 * header lowercasing, the redaction, the `Retry-After` precedence and the
 * body-sniffing that separates a rate limit from an exhausted quota are all the
 * production code paths, exercised here exactly as they run in production.
 *
 * `RequestExecutor` retries retryable statuses twice on its own before giving
 * up, so callers pass a short list whose *last* entry is the response under
 * test and whose earlier entries carry `retry-after-ms: 0` to keep the
 * executor's own (invisible, ten-second-capped) waits out of the test clock.
 * The resulting error is therefore the one a Session sees after the transport
 * layer has already done its job -- which is the whole point of the session
 * layer existing above it.
 */
export const executorFailure = (
  responses: ReadonlyArray<Response>,
  url = "https://api.anthropic.com/v1/messages",
): Effect.Effect<LLMError> =>
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    return yield* executor.execute(HttpClientRequest.post(url)).pipe(Effect.flip)
  }).pipe(
    Effect.provide(
      RequestExecutor.layer.pipe(
        Layer.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const cursor = yield* Ref.make(0)
              return Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.gen(function* () {
                    const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                    return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1]!)
                  }),
                ),
              )
            }),
          ),
        ),
      ),
    ),
    Effect.orDie,
  )

/** Two throwaway 429s that cost the executor no wall-clock time, then the real one. */
export const afterExecutorRetries = (response: Response) => [
  new Response("rate limited", { status: 429, headers: { "retry-after-ms": "0" } }),
  new Response("rate limited", { status: 429, headers: { "retry-after-ms": "0" } }),
  response,
]

/**
 * Anthropic's rate-limit response. The envelope -- `{type:"error",error:{type,message},request_id}`
 * -- is the one genuinely captured provider error in this repository
 * (`packages/llm/test/fixtures/recordings/anthropic-messages/rejects-malformed-assistant-tool-order-without-patch.json`,
 * an `invalid_request_error` on a 400); `rate_limit_error` is the same envelope
 * with the rate-limit type. The `anthropic-ratelimit-*` header family is the
 * one `RequestExecutor.rateLimitDetails` already parses.
 */
export const anthropicRateLimited = (headers: Record<string, string> = { "retry-after": "60" }) =>
  new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "Number of request tokens has exceeded your per-minute rate limit. Please reduce the prompt length or the maximum tokens requested, or try again later.",
      },
      request_id: "req_011CSf9dJgnzxKCY2BC2Beh",
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "request-id": "req_011CSf9dJgnzxKCY2BC2Beh",
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "0",
        "anthropic-ratelimit-requests-reset": "2026-07-28T12:01:00Z",
        ...headers,
      },
    },
  )

/**
 * Anthropic's overload response. `{"type":"error","error":{"type":"overloaded_error",...}}` is
 * the shape `packages/llm/src/protocols/anthropic-messages.ts` maps when it
 * arrives as a stream frame; on the status path it is a 529, which
 * `RequestExecutor.retryableStatus` already knows about.
 */
export const anthropicOverloaded = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
    status: 529,
    headers: { "content-type": "application/json" },
  })

/**
 * OpenAI's exhausted-quota response. Not a wait -- a billing state. The
 * "exceeded your current quota" wording is the string the desktop's retry card
 * already special-cases (`packages/session-ui/src/components/session-retry.tsx`),
 * and `insufficient_quota` in the body is what steers `RequestExecutor` to
 * `QuotaExceeded` rather than `RateLimit`.
 */
export const openaiQuotaExceeded = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  )
