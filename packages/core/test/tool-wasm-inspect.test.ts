import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { WasmInspectRuntime } from "@turenlabs/core/tool/wasm-inspect-runtime"
import { WasmInspectTools } from "@turenlabs/core/tool/wasm-inspect-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

describe("WasmInspectTools", () => {
  it.live("validates a module through bundled wasm-inspect WASM", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/module.wasm`, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("wasm_inspect")
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_wasm_inspect_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-wasm-inspect",
              name: "wasm_inspect",
              input: { path: "module.wasm", maxSections: 16 },
            },
          })
          expect(result.type).toBe("text")
          if (result.type !== "text") return
          expect(result.value).toContain('"valid": true')
          expect(result.value).toContain('"encoding": "module"')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                WasmInspectRuntime.node,
                WasmInspectTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
