export * as ConfigBuiltinToggle from "./builtin-toggle"

import { Schema, SchemaGetter } from "effect"

const RawEntry = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter<Record<string, unknown>>((entry) => {
    const extra = Object.keys(entry).find((key) => key !== "disabled")
    if (extra) return `Unsupported built-in adapter field: ${extra}`
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
      return "Built-in adapter 'disabled' must be a boolean"
    }
    return undefined
  }),
)

export const Entry = RawEntry.pipe(
  Schema.decodeTo(Schema.Struct({ disabled: Schema.optional(Schema.Boolean) }), {
    decode: SchemaGetter.transform((entry) =>
      typeof entry.disabled === "boolean" ? { disabled: entry.disabled } : {},
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

export function make(ids: readonly string[], identifier: string) {
  const allowed = new Set(ids)
  const entries = Schema.Record(Schema.String, Entry).check(
    Schema.makeFilter<Record<string, typeof Entry.Type>>((value) => {
      const unknown = Object.keys(value).find((id) => !allowed.has(id))
      return unknown ? `Unknown built-in adapter: ${unknown}` : undefined
    }),
  )
  return Schema.Union([Schema.Boolean, entries]).annotate({ identifier })
}
