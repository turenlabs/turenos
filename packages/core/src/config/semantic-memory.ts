export * as ConfigSemanticMemory from "./semantic-memory"

import { Schema } from "effect"

export const MODEL = "potion-base-8M" as const

export class Info extends Schema.Class<Info>("ConfigV2.SemanticMemory")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable local semantic memory retrieval and download the Potion model.",
  }),
  model: Schema.Literal(MODEL).pipe(Schema.optional).annotate({
    description: "The local embedding model used for semantic memory retrieval.",
  }),
}) {}
