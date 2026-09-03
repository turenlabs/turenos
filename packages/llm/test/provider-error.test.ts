import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src"
import { isTransientProviderError } from "../src/protocols/shared"

describe("provider error classification", () => {
  test("classifies Z.AI GLM token limit messages as context overflow", () => {
    expect(isContextOverflow("tokens in request more than max tokens allowed")).toBe(true)
  })

  // Production regression, and the reason a 1 952-message session became permanently
  // uncompactable: OpenAI's Responses API validates string lengths before it counts tokens, so an
  // oversized prompt is rejected as `string_above_max_length` with no mention of context anywhere
  // in the sentence. It classified as a plain invalid request, so compaction's shrink-and-retry
  // loop — the only escape hatch — never engaged and every attempt resent the same prompt.
  test("classifies an oversized input string as context overflow", () => {
    expect(
      isContextOverflow(
        "Invalid 'input[0].content[0].text': string too long. Expected a string with maximum length 1048576, but got a string with length 1891965 instead.",
      ),
    ).toBe(true)
    // The executor classifies from the raw response body, not from a pre-extracted message.
    expect(
      isContextOverflow(
        `Provider request failed with HTTP 400: {"error":{"message":"Invalid 'input[0].content[0].text': string too long. Expected a string with maximum length 1048576, but got a string with length 1891965 instead.","type":"invalid_request_error","param":"input[0].content[0].text","code":"string_above_max_length"}}`,
      ),
    ).toBe(true)
  })

  // The same error code covers a genuinely malformed request. A `call_id` four characters over a
  // 64-character cap is a bug in the request builder that no amount of shrinking repairs, and
  // treating it as an overflow would send the session compacting after a defect instead of
  // reporting it. The declared maximum is what separates the two meanings.
  test("keeps an oversized identifier a plain invalid request", () => {
    expect(
      isContextOverflow(
        "Invalid 'input[109].call_id': string too long. Expected a string with maximum length 64, but got a string with length 68 instead.",
      ),
    ).toBe(false)
  })

  // In-stream error frames arrive on a 200, so the HTTP-status retry never
  // sees them: unless the frame is marked retryable, the runner fails the turn
  // outright. Production regression: OpenAI's `server_is_overloaded` frames
  // failed every first attempt instead of entering the bounded retry.
  test("marks overload and rate-limit frames transient", () => {
    expect(isTransientProviderError("server_is_overloaded", "Our servers are currently overloaded.")).toBe(true)
    expect(isTransientProviderError("overloaded_error", "Overloaded")).toBe(true)
    expect(isTransientProviderError("rate_limit_exceeded", "Slow down")).toBe(true)
    expect(isTransientProviderError("resource_exhausted", "Please retry")).toBe(true)
    expect(isTransientProviderError("unavailable", "Temporary provider failure")).toBe(true)
    expect(isTransientProviderError("stream_read_error", "The upstream stream ended")).toBe(true)
    expect(isTransientProviderError("upstream_error", "The upstream failed")).toBe(true)
    expect(isTransientProviderError(undefined, "Please try again later.")).toBe(true)
    expect(isTransientProviderError("server_error", "An error occurred while processing your request.")).toBe(true)
    expect(isTransientProviderError(undefined, "fetch failed: ECONNRESET")).toBe(true)
    expect(isTransientProviderError(undefined, "The operation was aborted due to timeout")).toBe(true)
    expect(isTransientProviderError(undefined, "connect ENETUNREACH")).toBe(true)
  })

  test("keeps genuine request failures terminal", () => {
    expect(isTransientProviderError("invalid_request_error", "Bad schema")).toBe(false)
    expect(isTransientProviderError("authentication_error", "Invalid key, please try again later.")).toBe(false)
    expect(isTransientProviderError("context_length_exceeded", "Too many tokens")).toBe(false)
    expect(isTransientProviderError("insufficient_quota", "Please try again later")).toBe(false)
    expect(isTransientProviderError(undefined, "Unknown tool name")).toBe(false)
  })
})
