export * as Skill from "./skill"

import { Schema } from "effect"
import { optional } from "./schema"
import { AbsolutePath } from "./schema"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  slash: Schema.Boolean.pipe(optional),
  location: AbsolutePath,
  content: Schema.String,
}).annotate({ identifier: "SkillV2.Info" })

export interface EmbeddedSource extends Schema.Schema.Type<typeof EmbeddedSource> {}
export const EmbeddedSource = Schema.Struct({
  type: Schema.Literal("embedded"),
  skill: Schema.suspend(() => Info),
}).annotate({ identifier: "SkillV2.EmbeddedSource" })

export interface DirectorySource extends Schema.Schema.Type<typeof DirectorySource> {}
export const DirectorySource = Schema.Struct({
  type: Schema.Literal("directory"),
  directory: AbsolutePath,
}).annotate({ identifier: "SkillV2.DirectorySource" })

export type Source = EmbeddedSource | DirectorySource
export const Source = Object.assign(
  Schema.Union([EmbeddedSource, DirectorySource]).annotate({ identifier: "SkillV2.Source" }),
  {
    equals: (a: Source, b: Source) => Source.key(a) === Source.key(b),
    // A directory source is identified by its path, so the same directory registered twice
    // collapses to one source while two directories may each contribute a skill of any name.
    key: (source: Source) =>
      source.type === "embedded" ? `embedded:${source.skill.name}` : `directory:${source.directory}`,
  },
)
