export * as ConfigSkillPlugin from "./skill"

import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { Global } from "../../global"
import { define } from "../../plugin/define"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { SkillDiscovery } from "../../skill/discovery"

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const discovery = yield* SkillDiscovery.Service
    const global = yield* Global.Service
    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
        const seen = new Set<string>()
        const documents = (yield* config.entries())
          .filter((entry): entry is Config.Document => entry.type === "document" && entry.info.skills !== undefined)
          .toReversed()
        for (const document of documents) {
          for (const authored of document.info.skills ?? []) {
            const source = resolveSource(authored, document.path, global.home)
            if (!source) {
              yield* Effect.logWarning("ignored invalid skill source", { source: authored, config: document.path })
              continue
            }
            const key = source.type === "remote" ? `remote:${source.url}` : SkillV2.Source.key(source)
            if (seen.has(key)) continue
            seen.add(key)
            const directories = source.type === "remote" ? yield* discovery.pull(source.url) : [source.directory]
            directories.forEach((directory) =>
              draft.source(SkillV2.DirectorySource.make({ type: "directory", directory })),
            )
          }
        }
      }),
    )
  }),
})

export function resolveSource(value: string, configPath: string | undefined, home: string) {
  if (!value || value.trim() !== value || value.includes("\0")) return
  if (path.isAbsolute(value)) {
    return SkillV2.DirectorySource.make({ type: "directory", directory: AbsolutePath.make(path.resolve(value)) })
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const resolved = value === "~" ? home : path.join(home, value.slice(2))
    return SkillV2.DirectorySource.make({ type: "directory", directory: AbsolutePath.make(path.resolve(resolved)) })
  }
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return
    return { type: "remote" as const, url: url.href.endsWith("/") ? url.href : `${url.href}/` }
  } catch {
    if (!configPath) return
    return SkillV2.DirectorySource.make({
      type: "directory",
      directory: AbsolutePath.make(path.resolve(path.dirname(configPath), value)),
    })
  }
}
