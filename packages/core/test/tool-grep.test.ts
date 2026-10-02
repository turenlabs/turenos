import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { GrepTool } from "@turenlabs/core/tool/grep"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_grep_tool_test")
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
    const registry = yield* ToolRegistry.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    ),
  )
const call = (id: string, input: typeof GrepTool.Input.Encoded) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "grep", input },
})
const it = testEffect(Layer.empty)

describe("GrepTool", () => {
  it.live("searches existing files and directories without widening the scope", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "one.ts"), "needle\n"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "sibling.ts"), "needle\n"))
            yield* Effect.forEach(["src", "src/one.ts"], (target) =>
              Effect.gen(function* () {
                const result = yield* executeTool(registry, call(`call-${target}`, { pattern: "needle", path: target }))
                expect(result.type).toBe("text")
                expect(result.type === "text" ? result.value : "").toContain("src/one.ts:")
                expect(result.type === "text" ? result.value : "").not.toContain("sibling.ts")
              }),
            )
            expect(yield* executeTool(registry, call("call-no-match", { pattern: "absent", path: "src" }))).toEqual({
              type: "text",
              value: "No files found",
            })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports missing literal paths instead of searching their parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "one.ts"), "needle\n"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "two.ts"), "needle\n"))
            yield* Effect.forEach(["missing.ts", "missing", "{one,two}.ts"], (target) =>
              Effect.gen(function* () {
                const result = yield* executeTool(registry, call(`call-${target}`, { pattern: "needle", path: target }))
                expect(result.type).toBe("error")
                expect(result.type === "error" ? result.value : "").toContain("NotFound")
                expect(result.type === "error" ? result.value : "").toContain(target)
              }),
            )
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves regex parser errors", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* executeTool(registry, call("call-invalid-pattern", { pattern: "(" }))
            expect(result).toMatchObject({ type: "error", value: expect.stringContaining("regex parse error") })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
