import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SkillPlugin } from "@turenlabs/core/plugin/skill"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { escapeHtml } from "@/util/html"
import { Context, Effect, Layer, Schema } from "effect"

const CUSTOMIZE_FORGE_SKILL_NAME = "customize-forge"
const CUSTOMIZE_FORGE_SKILL_DESCRIPTION =
  "Use only when editing TurenOS's Extension-managed configuration, agents, commands, or permission rules."

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Skill") {}

const builtin: Info = {
  name: CUSTOMIZE_FORGE_SKILL_NAME,
  description: CUSTOMIZE_FORGE_SKILL_DESCRIPTION,
  location: "<built-in>",
  content: SkillPlugin.CustomizeForgeContent,
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const visible = Effect.fnUntraced(function* () {
      return (yield* ExtensionRuntime.enabledSkills(extensions)).flatMap(({ manifest, contribution }) => {
        if (
          manifest.id === Extension.ID.make("turenlabs", "customize-forge") &&
          contribution.source.type === "embedded"
        ) {
          return [builtin]
        }
        if (contribution.source.type !== "catalog") return []
        return [
          {
            name: contribution.id,
            description: contribution.description,
            location: `<extension:${manifest.id}>`,
            content: contribution.source.content,
          },
        ]
      })
    })

    const get = Effect.fn("Skill.get")(function* (name: string) {
      return (yield* visible()).find((skill) => skill.name === name)
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const skills = yield* visible()
      const info = skills.find((skill) => skill.name === name)
      if (info) return info
      return yield* new NotFoundError({ name, available: skills.map((skill) => skill.name).toSorted() })
    })

    const all = Effect.fn("Skill.all")(visible)
    const dirs = Effect.fn("Skill.dirs")(() => Effect.succeed([] as string[]))
    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const list = (yield* visible()).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${escapeHtml(skill.name)}</name>`,
          `    <description>${escapeHtml(skill.description ?? "")}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ExtensionRuntime.node],
})

export * as Skill from "."
