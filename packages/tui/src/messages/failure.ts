import { display, providerError, TURN_INTERRUPTED } from "../messages"
import type { Message } from "../agent/state"

/**
 * How the latest turn ended when it did not succeed: the assistant message after the last user message
 * carries an error. A turn that recovered, or has no assistant message yet, is not a failure.
 */
export function turnFailure(messages: Message[]) {
  const turn = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1)
  const last = turn.findLast((message) => message.type === "assistant")
  if (last?.type !== "assistant" || !last.error) return undefined
  if (TURN_INTERRUPTED.test(last.error.message))
    return { state: "interrupted" as const, text: "The turn was stopped before it finished." }
  const text = display(providerError(last.error.message), 1000).replace(/\s+/g, " ").trim()
  return { state: "failed" as const, text: text || "The assistant reported an error." }
}
