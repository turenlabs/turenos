import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect } from "bun:test"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(() => disposeAllInstances())

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])))
const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }

const skillTool = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const tool = (yield* registry.tools({
    providerID: ProviderV2.ID.openai,
    modelID: ModelV2.ID.make("gpt-5"),
    agent,
  })).find((candidate) => candidate.id === SkillTool.id)
  if (!tool) return yield* Effect.die(new Error("Skill tool not found"))
  return tool
})

describe("tool.skill", () => {
  it.instance("exposes a generic tool without discovering workspace skill files", () =>
    Effect.gen(function* () {
      const tool = yield* skillTool

      expect(tool.id).toBe("skill")
      expect(tool.description).not.toContain("customize-forge")
      expect(tool.description).not.toContain(".forge/skill")
    }),
  )

  it.instance("preserves the typed unavailable-skill message", () =>
    Effect.gen(function* () {
      const tool = yield* skillTool
      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) expect(error.message).toContain('Skill "missing-skill" not found.')
    }),
  )
})
