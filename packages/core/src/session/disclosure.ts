import { LLMRequest, Message, type ToolContent, type ToolOutput, type ToolResultValue } from "@turenlabs/llm"
import type { SecretOutput } from "../secret-output"
import { SecretRedaction } from "../secret-redaction"

/** Replaces one part the guard could not process; the raw value is never sent instead. */
export const WITHHELD = "[Content withheld: secret redaction failed]"

// Data only: never traverse provider metadata, signed reasoning or media payloads.
export function content(
  value: ReadonlyArray<ToolContent>,
  guard: SecretOutput.Snapshot = SecretRedaction,
): ReadonlyArray<ToolContent> {
  return value.map((part) => (part.type === "text" ? { ...part, text: guard.text(part.text) } : part))
}

export function result(value: ToolResultValue, guard: SecretOutput.Snapshot = SecretRedaction): ToolResultValue {
  return value.type === "content"
    ? { ...value, value: content(value.value, guard) }
    : { ...value, value: guard.json(value.value) }
}

/** Like {@link result}, but an unprocessable value becomes a fixed notice instead of a throw. */
export function safeResult(value: ToolResultValue, guard: SecretOutput.Snapshot = SecretRedaction): ToolResultValue {
  try {
    return result(value, guard)
  } catch {
    return { type: value.type === "error" ? "error" : "text", value: WITHHELD }
  }
}

export function output(value: ToolOutput, guard: SecretOutput.Snapshot = SecretRedaction): ToolOutput {
  return { structured: guard.json(value.structured), content: content(value.content, guard) }
}

/**
 * Guards every conversational and tool-result part independently. History is re-sent on every
 * turn, so one stored part the guard cannot process -- written by an older build, deeper than the
 * walk allows, or over the byte budget -- must cost only that part, not every later request.
 */
export function request(value: LLMRequest, guard: SecretOutput.Snapshot = SecretRedaction): LLMRequest {
  return LLMRequest.update(value, {
    system: value.system.map((part) => ({ ...part, text: safeText(part.text, guard) })),
    messages: value.messages.map(
      (message) =>
        new Message({
          ...message,
          content: message.content.map((part) => {
            if (part.type === "text") return { ...part, text: safeText(part.text, guard) }
            if (part.type === "tool-result") return { ...part, result: safeResult(part.result, guard) }
            return part
          }),
        }),
    ),
  })
}

function safeText(value: string, guard: SecretOutput.Snapshot) {
  try {
    return guard.text(value)
  } catch {
    return WITHHELD
  }
}

export * as SessionDisclosure from "./disclosure"
