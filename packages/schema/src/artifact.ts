export * as Artifact from "./artifact"

import { Schema } from "effect"
import { optional } from "./schema"

/** A generated file that clients can present as a clickable artifact. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
}).annotate({ identifier: "Artifact.Info" })
