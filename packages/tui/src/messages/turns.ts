import type { MessagesListOutput } from "@turenlabs/client"

type Message = MessagesListOutput["data"][number]
type Assistant = Extract<Message, { type: "assistant" }>

/** An assistant message directly after one with the same agent and model is another step of that turn. */
export function continuesTurn(message: Message | undefined, previous: Message | undefined) {
  if (message?.type !== "assistant" || previous?.type !== "assistant") return false
  return (
    message.agent === previous.agent &&
    message.model.providerID === previous.model.providerID &&
    message.model.id === previous.model.id &&
    message.model.variant === previous.model.variant
  )
}

/** A reader's own message after something else begins a new turn; machine-delivered updates do not. */
export function startsTurn(message: Message, previous: Message | undefined) {
  return previous !== undefined && message.type === "user" && (!message.source || message.source === "user")
}

/**
 * The time the header of `messages[index]` reports: its own, or for a turn of several steps the span
 * from the first step's start to the last step's end. A step still running leaves the span open, so no
 * duration shows until the whole turn is complete.
 */
export function turnTime(messages: readonly Message[], index: number, assistant: Assistant): Assistant["time"] {
  const end = turnEnd(messages, index)
  if (end === index) return assistant.time
  const steps = messages.slice(index, end + 1).filter((step): step is Assistant => step.type === "assistant")
  const complete = steps.every((step) => typeof step.time.completed === "number")
  return complete
    ? { created: assistant.time.created, completed: steps[steps.length - 1]!.time.completed }
    : { created: assistant.time.created }
}

function turnEnd(messages: readonly Message[], index: number): number {
  const next = index + 1
  return continuesTurn(messages[next], messages[index]) ? turnEnd(messages, next) : index
}
