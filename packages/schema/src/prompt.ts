import { Schema } from "effect"
import { ascending } from "./identifier"
import { optional } from "./schema"
import { NonNegativeInt, statics } from "./schema"
import { Swarm } from "./swarm"

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface TextPartSelection extends Schema.Schema.Type<typeof TextPartSelection> {}
export const TextPartSelection = Schema.Struct({
  startLine: NonNegativeInt,
  startChar: NonNegativeInt,
  endLine: NonNegativeInt,
  endChar: NonNegativeInt,
}).annotate({ identifier: "Prompt.TextPart.Selection" })

export interface TextPartComment extends Schema.Schema.Type<typeof TextPartComment> {}
export const TextPartComment = Schema.Struct({
  path: bounded(4_096),
  selection: TextPartSelection.pipe(optional),
  comment: bounded(100_000),
  preview: bounded(100_000).pipe(optional),
  origin: Schema.Literals(["review", "file"]).pipe(optional),
}).annotate({ identifier: "Prompt.TextPart.Comment" })

export interface TextPartMetadata extends Schema.Schema.Type<typeof TextPartMetadata> {}
export const TextPartMetadata = Schema.Struct({
  forgeComment: TextPartComment.pipe(optional),
  forgeSwarm: Swarm.Invocation.pipe(optional),
}).annotate({ identifier: "Prompt.TextPart.Metadata" })

// Historical Forge/OpenCode part IDs were only constrained to the `prt` prefix.
// Keep those IDs stable during transcript adoption; all newly generated IDs use `prt_`.
export const TextPartID = Schema.String.check(Schema.isStartsWith("prt"), Schema.isMaxLength(128)).pipe(
  statics((schema) => ({
    create: () => schema.make(`prt_${ascending()}`),
  })),
)
export type TextPartID = typeof TextPartID.Type

export interface TextPart extends Schema.Schema.Type<typeof TextPart> {}
export const TextPart = Schema.Struct({
  id: TextPartID,
  text: bounded(1_000_000),
  synthetic: Schema.Boolean.pipe(optional),
  ignored: Schema.Boolean.pipe(optional),
  metadata: TextPartMetadata.pipe(optional),
}).annotate({ identifier: "Prompt.TextPart" })

export const TextParts = Schema.Array(TextPart)
  .pipe(
    Schema.check(
      Schema.isMaxLength(256),
      Schema.makeFilter((parts) => new Set(parts.map((part) => part.id)).size === parts.length, {
        expected: "text parts with unique IDs",
        // JSON Schema can only describe whole-item uniqueness. Keep that portable
        // representation while the runtime predicate enforces the stronger ID invariant.
        meta: { _tag: "isUnique" },
        arbitrary: { constraint: { unique: true } },
      }),
    ),
  )
  .annotate({
    identifier: "Prompt.TextParts",
    description:
      "Ordered model-visible text. When present, these parts are authoritative over aggregate prompt text; ignored parts stay durable but are omitted from model and compaction context.",
  })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  parts: TextParts.pipe(optional),
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "parts" | "files" | "agents">) =>
        schema.make({
          text: input.text,
          ...(input.parts === undefined ? {} : { parts: input.parts }),
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
        }),
    })),
  )
