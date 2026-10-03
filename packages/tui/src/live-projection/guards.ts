import type { JsonValue } from "@turenlabs/client"
import { MAX_TEXT, type Part, type Tool } from "./types"

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
export const string = (value: unknown): value is string => typeof value === "string"
export const id = (value: unknown): value is string => string(value) && value.length > 0 && value.length <= 512
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
export const key = (part: Part) => `${part.type}:${part.id}`

// Bound traversal as well as retained strings/objects. SSE payloads are JSON, not class instances.
export function json(value: unknown): value is JsonValue {
  let budget = 262_144
  let nodes = 8192
  function visit(item: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 16) return false
    if (item === null || typeof item === "boolean" || finite(item)) return true
    if (string(item)) return (budget -= item.length) >= 0
    if (Array.isArray(item)) return item.length <= 8192 && item.every((entry) => visit(entry, depth + 1))
    if (!record(item) || Object.getPrototypeOf(item) !== Object.prototype) return false
    return Object.entries(item).every(([name, entry]) => (budget -= name.length) >= 0 && visit(entry, depth + 1))
  }
  return visit(value, 0)
}

export function content(value: unknown): value is Extract<Tool["state"], { status: "running" }>["content"] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) =>
        record(item) &&
        ((item.type === "text" && string(item.text) && item.text.length <= MAX_TEXT) ||
          (item.type === "file" &&
            string(item.uri) &&
            string(item.mime) &&
            (item.name === undefined || string(item.name)))),
    )
  )
}
