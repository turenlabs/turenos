import type { ModelMessage } from "ai"
import type { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"

/** Replaces one part the guard could not process; the raw value is never sent instead. */
export const WITHHELD = "[Content withheld: secret redaction failed]"
export const UNAVAILABLE = "Tool execution withheld because secret output protection is unavailable"

const unprocessable = Symbol("unprocessable")

export function text(value: string, guard: SecretOutput.Snapshot = SecretRedaction) {
  return attempt(() => guard.text(value), WITHHELD)
}

/**
 * Guards each prepared part independently: history is re-sent every step, so one stored part the
 * guard cannot process must cost only that part rather than every later request.
 */
export function messages(value: ModelMessage[], guard: SecretOutput.Snapshot = SecretRedaction): ModelMessage[] {
  const protect = (input: string) => text(input, guard)
  return value.map((message) => {
    if (typeof message.content === "string") return { ...message, content: protect(message.content) } as ModelMessage
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "text") return { ...part, text: protect(part.text) }
        if (part.type !== "tool-result") return part
        const output = part.output
        if (output.type === "text" || output.type === "error-text")
          return { ...part, output: { ...output, value: protect(output.value) } }
        if (output.type === "json" || output.type === "error-json") {
          const safe = attempt<unknown>(() => guard.json(output.value), unprocessable)
          if (safe === unprocessable)
            return { ...part, output: { type: output.type === "json" ? "text" : "error-text", value: WITHHELD } }
          return { ...part, output: { ...output, value: safe } }
        }
        if (output.type === "content")
          return {
            ...part,
            output: {
              ...output,
              value: output.value.map((item) => (item.type === "text" ? { ...item, text: protect(item.text) } : item)),
            },
          }
        return part
      }),
    } as ModelMessage
  })
}

/**
 * Runs one workflow-service tool callback. Protection is resolved first -- the callback does not
 * run without it -- and every reply, including failures, reaches the provider protected. Only an
 * own string `message` is read from a thrown value, so hostile getters and `toJSON` never run.
 */
export async function workflow(
  execute: () => PromiseLike<unknown>,
  abort: AbortSignal,
  protection: SecretOutput.Snapshot | PromiseLike<SecretOutput.Snapshot> = SecretRedaction,
) {
  const guard = await Promise.resolve(protection).catch(() => undefined)
  if (!guard) return { result: "", error: UNAVAILABLE }
  try {
    if (abort.aborted) throw new Error("Tool execution interrupted")
    const value = await execute()
    if (abort.aborted) throw new Error("Tool execution interrupted")
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
    const output = typeof value === "string" ? value : (record?.output ?? value)
    return {
      result: typeof output === "string" ? guard.text(output) : JSON.stringify(guard.json(output)),
      ...(record?.metadata === undefined ? {} : { metadata: guard.json(record.metadata) as Record<string, unknown> }),
      ...(typeof record?.title !== "string" ? {} : { title: guard.text(record.title) }),
    }
  } catch (error) {
    if (abort.aborted || isAbort(error)) throw new DOMException("Tool execution interrupted", "AbortError")
    const message = ownMessage(error)
    return {
      result: "",
      error:
        message === undefined ? "Tool execution failed" : attempt(() => guard.text(message), "Tool execution failed"),
    }
  }
}

function attempt<A>(run: () => A, fallback: A): A {
  try {
    return run()
  } catch {
    return fallback
  }
}

function ownMessage(error: unknown) {
  return attempt(() => {
    if (typeof error !== "object" || error === null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(error, "message")
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value
      ? descriptor.value
      : undefined
  }, undefined)
}

// The name is only compared, never emitted; a throwing accessor just means "not an abort".
function isAbort(error: unknown) {
  return attempt(() => error instanceof Error && error.name === "AbortError", false)
}

export * as LLMDisclosure from "./disclosure"
