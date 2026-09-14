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
import { BinaryDiffRuntime } from "@turenlabs/core/tool/binary-diff-runtime"
import { BinaryDiffTools } from "@turenlabs/core/tool/binary-diff-tools"
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

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        BinaryDiffRuntime.node,
        BinaryDiffTools.node,
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
  )

describe("BinaryDiffRuntime and BinaryDiffTools", () => {
  it.live("compares, diffs, patches, and inspects through a fresh binary-diff worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const oldBytes = new Uint8Array(256)
          const nextBytes = new Uint8Array(256)
          for (let i = 0; i < 256; i++) {
            oldBytes[i] = i
            nextBytes[i] = i
          }
          nextBytes[100] = 0xee
          nextBytes[101] = 0xee
          yield* Effect.promise(() => Bun.write(`${tmp.path}/old.bin`, oldBytes))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/next.bin`, nextBytes))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["binary_compare", "binary_regions", "binary_diff", "binary_patch", "binary_patch_info"])
            expect(names).toContain(name)

          const compare = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_binary_diff_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-binary-compare",
              name: "binary_compare",
              input: { old: "old.bin", next: "next.bin" },
            },
          })
          expect(compare.type).toBe("text")
          if (compare.type !== "text") return
          expect(compare.value).toContain('"schema_version"')
          expect(compare.value).toContain('"identical": false')

          const diff = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_binary_diff_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-binary-diff",
              name: "binary_diff",
              input: { old: "old.bin", next: "next.bin" },
            },
          })
          expect(diff.type).toBe("text")
          if (diff.type !== "text") return
          expect(diff.value).toContain("sha256")
          const artifactPath =
            typeof diff.value === "string" ? / to (\S+) \(sha256/.exec(diff.value)?.[1] : undefined
          expect(artifactPath).toBeTruthy()

          const info = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_binary_diff_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-binary-patch-info",
              name: "binary_patch_info",
              input: { patch: artifactPath! },
            },
          })
          expect(info.type).toBe("text")
          if (info.type !== "text") return
          expect(info.value).toContain('"well_formed": true')
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
