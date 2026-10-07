import { expect, test } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { PermissionV2 } from "@turenlabs/core/permission"
import { SessionV2 } from "@turenlabs/core/session"
import { AnimateTool } from "@turenlabs/core/tool/animate"
import { VisualizeTool } from "@turenlabs/core/tool/visualize"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { VisualizationGuidance } from "@turenlabs/core/tool/visualization-guidance"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const spec = {
  version: 1 as const,
  title: "Motion",
  html: '<svg><circle id="dot" r="4"/></svg>',
  tracks: [{ target: "dot", property: "x" as const, keyframes: [0, 100], duration: 1000 }],
}
const layer = (assert: PermissionV2.Interface["assert"]) =>
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, AnimateTool.node, VisualizeTool.node]),
    [
      [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
const settle = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  return yield* settleTool(registry, {
    sessionID: SessionV2.ID.make("ses_animate_test"),
    ...toolIdentity,
    call: { type: "tool-call", id: "animate-test", name: "animate", input: spec },
  })
})
const it = testEffect(
  layer((input) =>
    Effect.sync(() => {
      expect(input.action).toBe("animate")
      expect(input.resources).toEqual(["*"])
      expect(input.source).toEqual({ type: "tool", messageID: toolIdentity.assistantMessageID, callID: "animate-test" })
    }),
  ),
)

it.effect("advertises both visual tools by default without safehtml", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tools = yield* registry.materialize({ deferred: { selected: new Set() } })
    expect(tools.definitions.map((tool) => tool.name).sort()).toEqual(["animate", "visualize"])
    expect(tools.deferred).toEqual([])
    tools.definitions.forEach((tool) => expect(tool.description).toContain(VisualizationGuidance.TOOL))
    expect(VisualizationGuidance.SYSTEM).not.toContain("safehtml")
    expect(VisualizationGuidance.SYSTEM).toContain("linear timing")
  }),
)

it.effect("preserves animation metadata without echoing HTML to the model", () =>
  Effect.gen(function* () {
    const result = yield* settle
    expect(result.output?.structured).toEqual(spec)
    expect(result.result).toEqual({ type: "text", value: "Displayed animation in chat: Motion (1 tracks; paused)." })
  }),
)

test("permission denial publishes no animation", async () => {
  const result = await Effect.runPromise(
    settle.pipe(Effect.provide(layer(() => Effect.fail(new PermissionV2.BlockedError({ rules: [] })))), Effect.scoped),
  )
  expect(result.result).toEqual({ type: "error", value: "Animation permission denied" })
  expect(result.output).toBeUndefined()
})
