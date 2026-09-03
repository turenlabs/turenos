/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./define"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import { ExtensionRuntime } from "../extension"
import { Extension } from "@turenlabs/schema"
import customizeForgeContent from "./skill/customize-forge.md" with { type: "text" }

export const CustomizeForgeContent = customizeForgeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    const extensions = yield* ExtensionRuntime.Service
    if (!(yield* extensions.enabled(Extension.ID.make("turenlabs", "customize-forge")))) return
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-forge",
            description:
              "Use ONLY when the user is editing or creating forge's own configuration: forge.json, forge.jsonc, files under .forge/, or files under ~/.config/forge/. Also use when creating or fixing forge agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring forge itself.",
            location: AbsolutePath.make("/builtin/customize-forge.md"),
            content: CustomizeForgeContent,
          }),
        }),
      )
    })
  }),
})
