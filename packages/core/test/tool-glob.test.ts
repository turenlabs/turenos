import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { GlobTool } from "@turenlabs/core/tool/glob"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_glob_tool_test")

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

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, FSUtil.node, Ripgrep.node, GlobTool.node]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

const call = (input: typeof GlobTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-glob", name: "glob", input },
})

const it = testEffect(Layer.empty)

describe("GlobTool", () => {
  it.live("reports a line count beside every matched file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "three.ts"), "a\nb\nc\n"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "empty.ts"), ""))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "notes.txt"), "skip\n"))

            const settled = yield* settleTool(registry, call({ pattern: "**/*.ts" }))

            // ripgrep walks in parallel, so order is not part of the contract.
            const entries = [...(settled.output?.structured as typeof GlobTool.Output.Encoded)].sort((a, b) =>
              a.path.localeCompare(b.path),
            )
            expect(entries).toEqual([
              { path: "src/empty.ts", type: "file", lines: 0 },
              { path: "src/three.ts", type: "file", lines: 3 },
            ])
            const text = settled.result.type === "text" ? settled.result.value : ""
            // Location-relative: re-absolutizing prefixed every entry with the
            // workspace root and paid for it on every turn's history replay.
            expect(text).toContain("src/three.ts (3 lines)")
            expect(text).not.toContain(tmp.path)
            expect(text).not.toContain("notes.txt")
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
