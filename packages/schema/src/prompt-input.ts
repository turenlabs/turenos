export * as PromptInput from "./prompt-input"

import { Schema } from "effect"
import { AgentAttachment, Source, TextParts } from "./prompt"
import { optional, statics } from "./schema"

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "PromptInput.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) => schema.make(input),
    })),
  )

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  parts: TextParts.pipe(optional),
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
}).annotate({ identifier: "PromptInput" })
