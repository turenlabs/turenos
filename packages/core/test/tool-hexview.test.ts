import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { HexviewTool } from "@turenlabs/core/tool/hexview"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

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

describe("HexviewTool", () => {
  it.live("renders bounded portable hex and paging metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.bin`, Buffer.from("0001024142437fff", "hex")))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["hexview"])
          const settlement = yield* settleTool(registry, {
            sessionID: SessionV2.ID.make("ses_hexview_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-hexview",
              name: "hexview",
              input: { path: "sample.bin", offset: 1, length: 5, width: 8 },
            },
          })
          expect(settlement.output?.structured).toMatchObject({
            path: "sample.bin",
            offset: 1,
            length: 5,
            nextOffset: 6,
            bytes: "0102414243",
          })
          expect(settlement.result).toEqual({
            type: "text",
            value: [
              "sample.bin [0x00000001..0x00000006)",
              "0x00000001  01 02 41 42 43            |..ABC|",
              "[continue with offset 6]",
            ].join("\n"),
          })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, HexviewTool.node]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
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

  it.live("renders identical output for Windows-style byte content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.exe`, Buffer.from("4d5a900003000000", "hex")))
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_hexview_windows_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-hexview-windows",
              name: "hexview",
              input: { path: "sample.exe", length: 8, width: 8 },
            },
          })
          expect(result).toEqual({
            type: "text",
            value: "sample.exe [0x00000000..0x00000008)\n0x00000000  4d 5a 90 00 03 00 00 00   |MZ......|",
          })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, HexviewTool.node]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
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
