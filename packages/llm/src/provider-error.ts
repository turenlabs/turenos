import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

/**
 * An oversized prompt rejected as an oversized *string* rather than as too many tokens.
 *
 * OpenAI's Responses API validates the shape of a request before it counts tokens, so a single
 * enormous input string is rejected with `string_above_max_length`:
 *
 *   Invalid 'input[0].content[0].text': string too long. Expected a string with maximum length
 *   1048576, but got a string with length 1891965 instead.
 *
 * Nothing in that sentence says "context", so it used to classify as a plain invalid request --
 * and compaction, whose summarization prompt is one giant string, therefore never recognised its
 * own overflow and never shrank the prompt. A real session (1.9M-character summarization prompt
 * against a 1.05M-character cap) failed this way five times in a row with no recovery.
 *
 * The declared maximum is what separates the two meanings of this error. A four-digit-or-larger
 * cap is a payload limit and shrinking the input is the fix; a small cap (`call_id`, max 64) is a
 * malformed request that no amount of shrinking will repair, and must stay a plain failure.
 */
const OVERSIZED_STRING = /string (?:is )?too long[^\n]*?maximum length (\d+)/i
const OVERSIZED_STRING_MIN_LIMIT = 1_000

const isOversizedInput = (message: string) => {
  const match = OVERSIZED_STRING.exec(message)
  if (!match) return false
  const limit = Number(match[1])
  return Number.isFinite(limit) && limit >= OVERSIZED_STRING_MIN_LIMIT
}

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) ||
  isOversizedInput(message) ||
  /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
