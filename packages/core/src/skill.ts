export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Types } from "effect"
import path from "path"
import { Skill } from "@turenlabs/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { State } from "./state"
import { ExtensionRuntime } from "./extension"
import { Global } from "./global"

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const Source = Skill.Source
export type Source = Skill.Source

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const extensions = yield* ExtensionRuntime.Service
    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const loadEntry = Effect.fn("SkillV2.loadEntry")(function* (root: string, directory: string, entry: string) {
      if (!FSUtil.contains(root, entry)) return
      const content = yield* fs.readFileStringSafe(entry).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!content) return
      const parsed = ConfigMarkdown.parseOption(content)
      if (!parsed) return
      const frontmatter = parsed.data as { name?: unknown; description?: unknown }
      const name =
        typeof frontmatter.name === "string" && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : path.basename(directory)
      return {
        name,
        ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
        location: AbsolutePath.make(entry),
        content: parsed.content.trim(),
      }
    })

    // A directory may be one downloaded skill containing its entry directly, or a local root with
    // one skill per immediate child folder. Invalid entries are skipped independently.
    const fromDirectory = Effect.fn("SkillV2.fromDirectory")(function* (source: DirectorySource) {
      const realRoot = yield* fs.realPath(source.directory).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!realRoot) return []
      const folder = path.basename(realRoot)
      const direct = (yield* Effect.forEach(
        [path.join(realRoot, "SKILL.md"), path.join(realRoot, `${folder}.md`)],
        (file) => fs.realPath(file).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
      )).find((file) => file !== undefined)
      if (direct) {
        const info = yield* loadEntry(realRoot, realRoot, direct)
        return info ? [info] : []
      }
      const files = yield* fs
        .glob("*/*.md", { cwd: source.directory, absolute: true })
        .pipe(Effect.catchCause(() => Effect.succeed<string[]>([])))
      const grouped = new Map<string, string[]>()
      for (const file of files) {
        const parent = path.dirname(file)
        grouped.set(parent, [...(grouped.get(parent) ?? []), file])
      }
      const loaded: Info[] = []
      for (const [directory, candidates] of grouped) {
        const folder = path.basename(directory)
        const entry =
          candidates.find((file) => path.basename(file) === "SKILL.md") ??
          candidates.find((file) => path.basename(file) === `${folder}.md`)
        if (!entry) continue
        const real = yield* fs.realPath(entry).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!real) continue
        const info = yield* loadEntry(realRoot, directory, real)
        if (info) loaded.push(info)
      }
      return loaded
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      if (source.type === "embedded") return [source.skill]
      return yield* fromDirectory(source)
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      const seen = new Set<string>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) {
          if (seen.has(skill.name)) continue
          skills.set(skill.name, skill)
          seen.add(skill.name)
        }
      }
      for (const { manifest, contribution } of yield* ExtensionRuntime.enabledSkills(extensions)) {
        if (contribution.source.type !== "catalog" || seen.has(contribution.id)) continue
        skills.set(contribution.id, {
          name: contribution.id,
          description: contribution.description,
          location: AbsolutePath.make(
            path.join(Global.Path.data, "extension-skills", String(manifest.id), `${contribution.id}.md`),
          ),
          content: contribution.source.content,
        })
        seen.add(contribution.id)
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, ExtensionRuntime.node] })
