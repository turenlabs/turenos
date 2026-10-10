export * as SafeHtml from "./safehtml"

import { Schema } from "effect"

export const MAX_BYTES = 512 * 1024
export const Spec = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(160)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  html: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_BYTES)).annotate({
    description:
      "HTML with inline CSS and SVG for display in chat. Scripts, event handlers, links, and external resources are removed or blocked.",
  }),
}).check(
  Schema.makeFilter((value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_BYTES, {
    message: `Safe HTML data must not exceed ${MAX_BYTES} UTF-8 bytes`,
  }),
)
export type Spec = typeof Spec.Type
