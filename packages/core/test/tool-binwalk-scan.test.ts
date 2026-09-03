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
import { BinwalkScanRuntime } from "@turenlabs/core/tool/binwalk-scan-runtime"
import { BinwalkScanTools } from "@turenlabs/core/tool/binwalk-scan-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
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

describe("BinwalkScanRuntime and BinwalkScanTools", () => {
  it.live("scans a permission-checked file through a fresh binwalk worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const input = new Uint8Array(64)
          input.set(new TextEncoder().encode("HDR0"))
          new DataView(input.buffer).setUint32(4, 28, true)
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sample.bin`, input))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("binwalk_scan")
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_binwalk_scan_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-binwalk-scan",
              name: "binwalk_scan",
              input: { path: "sample.bin", maxFindings: 1 },
            },
          })
          expect(result.type).toBe("text")
          if (result.type !== "text") return
          expect(result.value).toContain('"schema_version"')
          expect(result.value).toContain('"input_bytes": 64')
          expect(result.value).toContain('"signature": "broadcom-trx"')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                BinwalkScanRuntime.node,
                BinwalkScanTools.node,
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
