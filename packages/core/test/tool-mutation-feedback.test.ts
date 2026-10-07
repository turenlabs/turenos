import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ApplyPatchTool } from "@turenlabs/core/tool/apply-patch"
import { EditTool } from "@turenlabs/core/tool/edit"
import { WriteTool } from "@turenlabs/core/tool/write"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { executeTool, toolIdentity } from "./lib/tool"

const tools = [
  {
    name: "edit",
    input: (target: string) => ({ path: target, oldString: "before", newString: "after" }),
  },
  {
    name: "write",
    input: (target: string) => ({ path: target, content: "after\n" }),
  },
  {
    name: "apply_patch",
    input: (target: string) => ({
      patchText: `*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`,
    }),
  },
]

for (const tool of tools) {
  test.each(["edit", "external_directory"])(
    `${tool.name} preserves %s correction feedback without writing`,
    async (action) => {
      await using active = await tmpdir()
      await using outside = await tmpdir()
      const target = path.join(action === "edit" ? active.path : outside.path, "file.txt")
      await fs.writeFile(target, "before\n")
      const feedback = "Leave this file unchanged; update the test fixture instead."
      const assertions: PermissionV2.AssertInput[] = []
      const reads: string[] = []
      const permission = Layer.succeed(
        PermissionV2.Service,
        PermissionV2.Service.of({
          assert: (input) =>
            Effect.sync(() => assertions.push(input)).pipe(
              Effect.andThen(
                input.action === action ? Effect.fail(new PermissionV2.CorrectedError({ feedback })) : Effect.void,
              ),
            ),
          ask: () => Effect.die("unused"),
          reply: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          forSession: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
        }),
      )
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            readFile: (target) => Effect.sync(() => reads.push(target)).pipe(Effect.andThen(fs.readFile(target))),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_mutation_feedback_test"),
            ...toolIdentity,
            call: { type: "tool-call", id: `call-${tool.name}-${action}`, name: tool.name, input: tool.input(target) },
          })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([ToolRegistry.toolsNode, EditTool.node, WriteTool.node, ApplyPatchTool.node]),
              [
                [FSUtil.node, filesystem],
                [
                  Location.node,
                  Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(active.path) })),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      )
      expect(assertions.map((input) => input.action)).toEqual([action])
      expect(reads).toEqual([])
      expect(await fs.readFile(target, "utf8")).toBe("before\n")
      expect(result).toEqual({ type: "error", value: feedback })
    },
  )
}
