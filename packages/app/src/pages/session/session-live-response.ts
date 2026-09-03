import type { Message, Part } from "@turenlabs/sdk/v2"

type AssistantStatusEvent =
  | { type: "recovered"; index: number; time: number | undefined }
  | { type: "error"; error: string; index: number; time: number | undefined }

export function sessionLiveError(input: {
  working: boolean
  attention: boolean
  messages: readonly Message[]
  parts: Readonly<Record<string, readonly Part[]>>
}) {
  if (input.working || input.attention) return
  return latestAssistantError(input.messages, input.parts)
}

export function latestAssistantResponse(
  messages: readonly Message[],
  parts: Readonly<Record<string, readonly Part[]>>,
) {
  return messages
    .flatMap((message) =>
      message.role === "assistant"
        ? [
            (parts[message.id] ?? [])
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
              .trim(),
          ]
        : [],
    )
    .findLast((text) => text.length > 0)
}

export function latestAssistantError(messages: readonly Message[], parts: Readonly<Record<string, readonly Part[]>>) {
  for (const message of messages.toReversed()) {
    const terminal = assistantError(message)
    if (terminal) return terminal
    const relevant = (parts[message.id] ?? []).flatMap<AssistantStatusEvent>((part, index) => {
      if (message.role === "assistant" && part.type === "text" && part.text.trim())
        return [{ type: "recovered" as const, index, time: part.time?.end ?? part.time?.start }]
      if (message.role === "assistant" && part.type === "tool" && part.state.status === "completed")
        return [{ type: "recovered" as const, index, time: part.state.time.end }]
      if (part.type === "tool" && part.state.status === "error")
        return [{ type: "error" as const, error: part.state.error, index, time: part.state.time.end }]
      return []
    })
    const latest = relevant.reduce<(typeof relevant)[number] | undefined>((current, item) => {
      if (!current) return item
      if (current.time !== undefined && item.time !== undefined && current.time !== item.time)
        return current.time > item.time ? current : item
      return current.index > item.index ? current : item
    }, undefined)
    if (latest?.type === "recovered") return
    if (latest?.type === "error") return latest.error
  }
}

function assistantError(message: Message) {
  if (message.role !== "assistant" || !message.error || message.error.name === "MessageAbortedError") return
  if ("message" in message.error.data && typeof message.error.data.message === "string" && message.error.data.message)
    return message.error.data.message
  if (message.error.name === "MessageOutputLengthError") return "The model reached its output limit."
  return "The assistant could not complete the latest response."
}
