import { describe, expect, test } from "bun:test"
import { Visualization } from "@turenlabs/schema/visualization"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { PermissionV2 } from "@turenlabs/core/permission"
import { SessionV2 } from "@turenlabs/core/session"
import { VisualizeTool } from "@turenlabs/core/tool/visualize"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const spec = {
  version: 1 as const,
  title: "File sizes",
  kind: "treemap" as const,
  unit: "lines",
  items: [{ label: "index.ts", value: 240, group: "src", detail: "Measured from the workspace" }],
}

describe("visualization validation", () => {
  test("accepts each chart kind and zero values", () => {
    ;["bar", "line", "treemap"].forEach((kind) => {
      expect(Schema.is(Visualization.Spec)({ ...spec, kind, items: [{ label: "Empty", value: 0 }] })).toBe(true)
    })
  })

  test("rejects excessive, nonfinite, negative, and empty data", () => {
    ;[NaN, Infinity, -Infinity, -1, 1e12 + 1].forEach((value) => {
      expect(Schema.is(Visualization.Spec)({ ...spec, items: [{ label: "Bad", value }] })).toBe(false)
    })
    expect(Schema.is(Visualization.Spec)({ ...spec, items: [] })).toBe(false)
    expect(Schema.is(Visualization.Spec)({ ...spec, items: Array(501).fill(spec.items[0]) })).toBe(false)
    expect(Schema.is(Visualization.Spec)({ ...spec, kind: "html" })).toBe(false)
    expect(Schema.is(Visualization.Spec)({ ...spec, version: 2 })).toBe(false)
    expect(Schema.is(Visualization.Spec)({ ...spec, title: "x".repeat(161) })).toBe(false)
  })

  test("bounds total encoded bytes and treats markup as text", () => {
    expect(
      Schema.is(Visualization.Spec)({
        ...spec,
        items: Array(500).fill({ label: "x", value: 1, detail: "x".repeat(1000) }),
      }),
    ).toBe(false)
    const decoded = Schema.decodeUnknownSync(Visualization.Spec)({
      ...spec,
      title: "<script>alert(1)</script>",
      items: [{ label: "<img src=x onerror=alert(1)>", value: 1 }],
      html: "<script>ignored()</script>",
    })
    expect(decoded.title).toBe("<script>alert(1)</script>")
    expect("html" in decoded).toBe(false)
  })
})

const visualizationLayer = (assert: PermissionV2.Interface["assert"]) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, VisualizeTool.node]), [
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])

const it = testEffect(visualizationLayer(() => Effect.void))

it.effect("registers and preserves structured chart data with a compact model result", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["visualize"])
    const result = yield* settleTool(registry, {
      sessionID: SessionV2.ID.make("ses_visualize_test"),
      ...toolIdentity,
      call: { type: "tool-call", id: "visualize-test", name: "visualize", input: spec },
    })
    expect(result.output?.structured).toEqual(spec)
    expect(result.result).toEqual({ type: "text", value: "Displayed treemap visualization: File sizes (1 items)." })
  }),
)

test("does not display data when permission is denied", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      return yield* settleTool(registry, {
        sessionID: SessionV2.ID.make("ses_visualize_denied"),
        ...toolIdentity,
        call: { type: "tool-call", id: "visualize-denied", name: "visualize", input: spec },
      })
    }).pipe(
      Effect.provide(visualizationLayer(() => Effect.fail(new PermissionV2.BlockedError({ rules: [] })))),
      Effect.scoped,
    ),
  )
  expect(result.result).toEqual({ type: "error", value: "Visualization permission denied" })
  expect(result.output).toBeUndefined()
})
