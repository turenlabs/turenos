import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { YolkSystemContext } from "@turenlabs/core/system-context/yolk"
import { testEffect } from "../lib/effect"

const activation = { enabled: false }
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, YolkSystemContext.node]), [
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, { enabled: () => Effect.succeed(activation.enabled) }),
    ],
  ]),
)

describe("YolkSystemContext", () => {
  it.effect("adds and removes agent usage policy with live extension state", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      activation.enabled = false
      expect((yield* SystemContext.initialize(yield* registry.load())).baseline).toBe("")

      activation.enabled = true
      const enabled = yield* SystemContext.initialize(yield* registry.load())
      expect(enabled.baseline).toContain("Yolk change-intelligence policy")
      expect(enabled.baseline).toContain("Do not guess several names")
      expect(enabled.baseline).toContain("does not observe Solid/React tracking")
      expect(enabled.baseline).toContain("Unknown, partial, or incomplete-index results are not a diagnosis")

      activation.enabled = false
      const disabled = yield* SystemContext.reconcile(yield* registry.load(), enabled.snapshot)
      expect(disabled._tag).toBe("Updated")
      if (disabled._tag === "Updated") expect(disabled.text).toContain("Yolk is disabled")
    }),
  )
})
