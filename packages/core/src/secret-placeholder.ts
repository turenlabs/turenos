export * as SecretPlaceholder from "./secret-placeholder"

import { types } from "node:util"

/**
 * Prefix of the `[SECRET:v1:<rule>:<fingerprint>]` references that secret redaction writes in
 * place of credentials. Matching the bare prefix also refuses previews that cut a reference
 * mid-marker.
 */
export const PREFIX = "[SECRET:v1"

const MAX_BYTES = 16 * 1024 * 1024
const MAX_NODES = 100_000
const MAX_DEPTH = 64

/**
 * Whether any string in `value`, including object keys, contains a secret placeholder.
 *
 * Shares the semantics of the secret-output guard's `containsPlaceholder` (PR #142): every string
 * reachable through plain data is inspected. Values the walk cannot read safely -- cycles,
 * proxies, accessors, class instances, functions, bigints, non-finite numbers, or input beyond the
 * node, depth, or byte budgets -- count as containing a placeholder, so callers fail closed.
 * Accessors, `toJSON` hooks, and proxy traps are never invoked.
 */
export function containsPlaceholder(value: unknown): boolean {
  return visit(value, { nodes: 0, bytes: 0 }, new WeakSet(), 0)
}

function visit(value: unknown, budget: { nodes: number; bytes: number }, active: WeakSet<object>, depth: number) {
  budget.nodes += 1
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) return true
  if (typeof value === "string") return inspect(value, budget)
  if (value === undefined || value === null || typeof value === "boolean") return false
  if (typeof value === "number") return !Number.isFinite(value)
  if (typeof value !== "object" || types.isProxy(value) || active.has(value)) return true
  const prototype = Object.getPrototypeOf(value)
  const array = Array.isArray(value)
  if (!array && prototype !== Object.prototype && prototype !== null) return true
  const names = Object.keys(value)
  if (names.length + budget.nodes > MAX_NODES) return true
  if (array && (names.length !== value.length || names.some((key, index) => key !== String(index)))) return true
  active.add(value)
  const found = names.some((key) => {
    if (!array && inspect(key, budget)) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) return true
    return visit(descriptor.value, budget, active, depth + 1)
  })
  active.delete(value)
  return found
}

function inspect(value: string, budget: { bytes: number }) {
  budget.bytes += Buffer.byteLength(value, "utf8")
  if (budget.bytes > MAX_BYTES) return true
  return value.includes(PREFIX)
}
