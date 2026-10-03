import { invalid, isRecord } from "../response-validation"
import { UNSAFE_TEXT } from "../response-validation/primitives"

export type AuthPrompt = {
  key: string
  message: string
  when?: { key: string; op: "eq" | "neq"; value: string }
} & (
  | { type: "text"; placeholder?: string }
  | { type: "select"; options: { label: string; value: string; hint?: string }[] }
)

export type AuthMethod = { type: "oauth" | "api"; label: string; prompts?: AuthPrompt[] }

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid("provider object")
  return value
}

export function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid("provider collection")
  return value
}

export function text(value: unknown, field: string, limit = 512, empty = false, multiline = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!empty && !value.trim()) ||
    UNSAFE_TEXT.test(multiline ? value.replaceAll("\n", "") : value)
  )
    throw new Error(`Invalid ${field}: check length and control characters.`)
  return value
}

export function id(value: unknown, model = false) {
  const result = text(value, model ? "model ID" : "provider or auth ID", model ? 512 : 256)
  if (
    ["__proto__", "prototype", "constructor"].includes(result) ||
    result !== result.trim() ||
    (!model && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result))
  )
    throw new Error("Invalid provider, model, or auth ID.")
  return result
}

export function credential(value: unknown) {
  const result = text(value, "credential", 8192)
  if (result !== result.trim()) throw new Error("Remove surrounding whitespace from the credential.")
  return result
}

export function methodIndex(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 32) throw new Error("Choose a valid auth method index.")
}

export function endpoint(value: string) {
  const url = URL.parse(text(value, "provider URL", 4096))
  if (!url || url.username || url.password || value.includes("?") || value.includes("#"))
    throw new Error("Use a provider URL without credentials, a query, or a fragment.")
  // Match SessionRunnerModel's runtime policy without importing Core into the TUI.
  const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ? url.hostname.split(".").map(Number) : []
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Use HTTPS, or HTTP on a runtime-supported private or loopback provider address.")
  return url.href
}

export function prompt(value: unknown): AuthPrompt {
  const item = record(value)
  const base: Pick<AuthPrompt, "key" | "message" | "when"> = {
    key: id(item.key),
    message: text(item.message, "auth prompt"),
  }
  if (item.when !== undefined) {
    const when = record(item.when)
    if (when.op !== "eq" && when.op !== "neq") invalid("auth prompt condition")
    base.when = { key: id(when.key), op: when.op, value: text(when.value, "auth condition", 4096, true) }
  }
  if (item.type === "text")
    return {
      ...base,
      type: "text",
      ...(item.placeholder === undefined ? {} : { placeholder: text(item.placeholder, "auth placeholder", 512, true) }),
    }
  if (item.type !== "select") invalid("auth prompt type")
  return {
    ...base,
    type: "select",
    options: array(item.options, 128).map((value) => {
      const option = record(value)
      return {
        label: text(option.label, "auth option label"),
        value: text(option.value, "auth option value", 4096, true),
        ...(option.hint === undefined ? {} : { hint: text(option.hint, "auth option hint", 512, true) }),
      }
    }),
  }
}
