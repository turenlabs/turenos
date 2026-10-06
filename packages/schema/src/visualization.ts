export * as Visualization from "./visualization"

import { Schema } from "effect"

export const MAX_ITEMS = 500
export const MAX_BYTES = 128 * 1024

export const Item = Schema.Struct({
  label: Schema.NonEmptyString.check(Schema.isMaxLength(240)),
  value: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  group: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(120))),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
})
export type Item = typeof Item.Type

export const Spec = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(160)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  kind: Schema.Literals(["bar", "line", "treemap"]),
  unit: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
  items: Schema.Array(Item).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ITEMS)),
}).check(
  Schema.makeFilter((value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_BYTES, {
    message: `Visualization data must not exceed ${MAX_BYTES} UTF-8 bytes`,
  }),
)
export type Spec = typeof Spec.Type
