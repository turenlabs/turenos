import { display, providerError, TURN_INTERRUPTED } from "../messages"
import type { Message } from "../agent/state"

// A restart or crash leaves the step's message without the completion time, finish reason and error
// that a finished or failed step always records (packages/core/src/session/message-updater.ts).
const UNFINISHED = "The turn ended without a recorded finish (the server may have restarted)."

/**
 * How the latest turn ended when it did not succeed: the assistant message after the last user message
 * carries an error, or was never finished. A turn that recovered, or has no assistant message yet, is not
 * a failure. Callers ask only about a session that is not running: a running turn has no finish yet.
 */
export function turnFailure(messages: Message[]) {
  const last = lastAssistant(messages)
  if (!last) return undefined
  if (!last.error) return unfinished(last) ? { state: "interrupted" as const, text: UNFINISHED } : undefined
  if (TURN_INTERRUPTED.test(last.error.message))
    return { state: "interrupted" as const, text: "The turn was stopped before it finished." }
  const text = display(providerError(last.error.message), 1000).replace(/\s+/g, " ").trim()
  return { state: "failed" as const, text: text || "The assistant reported an error." }
}

/** The transcript line for a turn that was never finished, or "" (bold in the dashboard's Markdown when `rich`). */
export function interruptedLine(messages: readonly Message[], rich = false) {
  const last = lastAssistant(messages)
  if (!last || last.error || !unfinished(last)) return ""
  return rich ? `**INTERRUPTED: ${UNFINISHED}**` : `INTERRUPTED: ${UNFINISHED}`
}

function lastAssistant(messages: readonly Message[]) {
  const turn = messages.slice(messages.findLastIndex((message) => message.type === "user") + 1)
  const last = turn.findLast((message) => message.type === "assistant")
  return last?.type === "assistant" ? last : undefined
}

function unfinished(message: Extract<Message, { type: "assistant" }>) {
  return typeof message.time.completed !== "number" && typeof message.finish !== "string"
}
