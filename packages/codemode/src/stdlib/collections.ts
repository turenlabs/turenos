export const arrayMethods = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "includes",
  "join",
  "reduce",
  "reduceRight",
  "flatMap",
  "forEach",
  "sort",
  "toSorted",
  "slice",
  "concat",
  "indexOf",
  "lastIndexOf",
  "at",
  "flat",
  "reverse",
  "toReversed",
  "with",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "copyWithin",
  "keys",
  "values",
  "entries",
])

export const mapMethods = new Set(["get", "set", "has", "delete", "clear", "forEach", "keys", "values", "entries"])

export const setMethods = new Set(["add", "has", "delete", "clear", "forEach", "keys", "values", "entries"])

export const spreadItems = (value: unknown, budget?: ExecutionBudget): Array<unknown> | undefined => {
  budget?.value(value)
  if (typeof value === "string" || Array.isArray(value)) budget?.slots(value.length)
  if (value instanceof SandboxMap) budget?.slots(value.map.size * 3)
  if (value instanceof SandboxSet) budget?.slots(value.set.size)
  if (value instanceof SandboxURLSearchParams) budget?.slots(value.params.size * 3)
  if (Array.isArray(value)) return value
  if (typeof value === "string") return Array.from(value)
  if (value instanceof SandboxMap) return Array.from(value.map.entries(), ([key, item]) => [key, item])
  if (value instanceof SandboxSet) return Array.from(value.set.values())
  if (value instanceof SandboxURLSearchParams) return Array.from(value.params.entries(), ([key, item]) => [key, item])
  return undefined
}
import { SandboxMap, SandboxSet, SandboxURLSearchParams } from "../values.js"
import type { ExecutionBudget } from "../interpreter/budget.js"
