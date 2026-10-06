import { describe, expect, test } from "bun:test"
import { SafeHtml } from "@turenlabs/schema/safehtml"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { PermissionV2 } from "@turenlabs/core/permission"
import { SessionV2 } from "@turenlabs/core/session"
import { SafeHtmlTool } from "@turenlabs/core/tool/safehtml"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { VisualizationGuidance } from "@turenlabs/core/tool/visualization-guidance"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const spec = {
  version: 1 as const,
  title: "File Sizes",
  html: "<style>summary {font-weight:600}</style><details><summary>Source files</summary><p>Measured: 240 lines</p></details>",
}

describe("Safe HTML schema", () => {
  test("preserves HTML for sanitization at the rendering boundary", () => {
    expect(Schema.decodeUnknownSync(SafeHtml.Spec)(spec)).toEqual(spec)
  })
  test("rejects empty, unsupported, and excessive payloads", () => {
    ;[
      { ...spec, version: 2 },
      { ...spec, html: "" },
      { ...spec, title: "x".repeat(161) },
      { ...spec, html: "x".repeat(SafeHtml.MAX_BYTES) },
      { ...spec, html: "\u00e9".repeat(SafeHtml.MAX_BYTES / 2) },
    ].forEach((value) => expect(Schema.is(SafeHtml.Spec)(value)).toBe(false))
  })
})

const layer = (assert: PermissionV2.Interface["assert"]) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SafeHtmlTool.node]), [
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])

const settle = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["safehtml"])
  return yield* settleTool(registry, {
    sessionID: SessionV2.ID.make("ses_safehtml_test"),
    ...toolIdentity,
    call: { type: "tool-call", id: "safehtml-test", name: "safehtml", input: spec },
  })
})

const it = testEffect(layer(() => Effect.void))

it.effect("advertises safehtml even when no deferred tools are loaded", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tools = yield* registry.materialize({ deferred: { selected: new Set() } })
    expect(tools.definitions.map((tool) => tool.name)).toEqual(["safehtml"])
    expect(tools.definitions[0]?.description).toContain(VisualizationGuidance.TOOL)
    expect(tools.deferred.some((tool) => tool.name === "safehtml")).toBe(false)
  }),
)

it.effect("stores artifact source with compact model output", () =>
  Effect.gen(function* () {
    const result = yield* settle
    expect(result.output?.structured).toEqual(spec)
    expect(result.result).toEqual({
      type: "text",
      value: "Displayed Safe HTML in chat: File Sizes.",
    })
  }),
)

test("permission denial does not publish an artifact", async () => {
  const result = await Effect.runPromise(
    settle.pipe(Effect.provide(layer(() => Effect.fail(new PermissionV2.BlockedError({ rules: [] })))), Effect.scoped),
  )
  expect(result.result).toEqual({ type: "error", value: "Safe HTML permission denied" })
  expect(result.output).toBeUndefined()
})
