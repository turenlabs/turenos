import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { SkillPlugin } from "@turenlabs/core/plugin/skill"
import { SkillV2 } from "@turenlabs/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SkillV2.node, ExtensionRuntime.node])))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-forge skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-forge",
          description: expect.stringContaining("forge's own configuration"),
        }),
      )
    }),
  )
})
