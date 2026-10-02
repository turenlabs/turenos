import { LLMRequest, Message, type ToolContent, type ToolOutput, type ToolResultValue } from "@turenlabs/llm"
import type { SecretOutput } from "../secret-output"
import { SecretRedaction } from "../secret-redaction"

/** Replaces one part the guard could not process; the raw value is never sent instead. */
export const WITHHELD = "[Content withheld: secret redaction failed]"

// Data only: never traverse provider metadata, signed reasoning or media payloads. Unchanged values
// are returned by reference so a request with nothing to redact is not rebuilt (see `request`).
export function content(
  value: ReadonlyArray<ToolContent>,
  guard: SecretOutput.Snapshot = SecretRedaction,
): ReadonlyArray<ToolContent> {
  const next = value.map((part) => {
    if (part.type !== "text") return part
    const text = guard.text(part.text)
    return text === part.text ? part : { ...part, text }
  })
  return same(next, value) ? value : next
}

export function result(value: ToolResultValue, guard: SecretOutput.Snapshot = SecretRedaction): ToolResultValue {
  const next = value.type === "content" ? content(value.value, guard) : guard.json(value.value)
  return next === value.value ? value : ({ ...value, value: next } as ToolResultValue)
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
  const system = value.system.map((part) => {
    const text = safeText(part.text, guard)
    return text === part.text ? part : { ...part, text }
  })
  const messages = value.messages.map((message) => {
    const next = message.content.map((part) => {
      if (part.type === "text") {
        const text = safeText(part.text, guard)
        return text === part.text ? part : { ...part, text }
      }
      if (part.type === "tool-result") {
        const safe = safeResult(part.result, guard)
        return safe === part.result ? part : { ...part, result: safe }
      }
      return part
    })
    return same(next, message.content) ? message : new Message({ ...message, content: next })
  })
  const systemSame = same(system, value.system)
  const messagesSame = same(messages, value.messages)
  if (systemSame && messagesSame) return value
  return LLMRequest.update(value, {
    ...(systemSame ? {} : { system }),
    ...(messagesSame ? {} : { messages }),
  })
}

function same<A>(next: ReadonlyArray<A>, previous: ReadonlyArray<A>) {
  return next.every((item, index) => item === previous[index])
}

function safeText(value: string, guard: SecretOutput.Snapshot) {
  try {
    return guard.text(value)
  } catch {
    return WITHHELD
  }
}

export * as SessionDisclosure from "./disclosure"
