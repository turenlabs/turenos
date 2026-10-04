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
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_glob_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const guard = { allowExternal: false }
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(
        Effect.andThen(
          input.action === "external_directory" && !guard.allowExternal
            ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  authorization = permission,
  backend?: Layer.Layer<Ripgrep.Service>,
) =>
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
          [PermissionV2.node, authorization],
          ...(backend ? [[Ripgrep.node, backend] as const] : []),
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

const call = (input: typeof GlobTool.Input.Type, id = "call-glob") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "glob", input },
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

  it.live("lists the authorized canonical target if an alias changes during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const alias = path.join(outside.path, "alias")
          const approved = path.join(outside.path, "approved")
          const denied = path.join(outside.path, "denied")
          yield* Effect.promise(async () => {
            await fs.mkdir(approved)
            await fs.mkdir(denied)
            await fs.writeFile(path.join(approved, "approved.txt"), "safe\n")
            await fs.writeFile(path.join(denied, "unauthorized.txt"), "private\n")
            await fs.symlink(approved, alias)
          })
          const authorization = Layer.mock(PermissionV2.Service, {
            assert: (input) =>
              input.action === "external_directory"
                ? Effect.promise(async () => {
                    expect(input.resources).toEqual([`${approved.replaceAll("\\", "/")}/*`])
                    await fs.unlink(alias)
                    await fs.symlink(denied, alias)
                  })
                : Effect.void,
          })
          yield* withTool(
            active.path,
            (registry) =>
              Effect.gen(function* () {
                const result = yield* settleTool(registry, call({ pattern: "*", path: RelativePath.make(alias) }))
                expect(result.result.type).toBe("text")
                expect(result.result.type === "text" ? result.result.value : "").toContain("approved.txt")
                expect(result.result.type === "text" ? result.result.value : "").not.toContain("unauthorized.txt")
              }),
            authorization,
          )
        }),
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )

  it.live("does not invoke search or line-count reads when either permission is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.forEach(["external_directory", "glob"], (action) => {
          const requests: string[] = []
          const reads: string[] = []
          const authorization = Layer.mock(PermissionV2.Service, {
            assert: (input) =>
              Effect.sync(() => requests.push(input.action)).pipe(
                Effect.andThen(
                  input.action === action ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
                ),
              ),
          })
          const backend = Layer.mock(Ripgrep.Service, {
            grep: () =>
              Effect.sync(() => {
                reads.push("grep")
                return []
              }),
            glob: () =>
              Effect.sync(() => {
                reads.push("glob")
                return []
              }),
            lines: () =>
              Effect.sync(() => {
                reads.push("lines")
                return new Map<string, number>()
              }),
          })
          return withTool(
            active.path,
            (registry) =>
              Effect.gen(function* () {
                const result = yield* settleTool(
                  registry,
                  call({ pattern: "*", path: RelativePath.make(outside.path) }, `call-denied-${action}`),
                )
                expect(result.result).toMatchObject({
                  type: "error",
                  value: expect.stringContaining("Permission denied: glob"),
                })
                expect(requests).toEqual(action === "external_directory" ? [action] : ["external_directory", action])
                expect(reads).toEqual([])
              }),
            authorization,
            backend,
          )
        }),
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )

  it.live("rejects escaping aliases and keeps recursive searches from following symlinks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(active.path, "inside"))
            await fs.writeFile(path.join(active.path, "inside", "local.txt"), "LOCAL\n")
            await fs.writeFile(path.join(outside.path, "private.txt"), "PRIVATE\n")
            await fs.symlink(outside.path, path.join(active.path, "escape"))
            await fs.symlink(path.join(outside.path, "private.txt"), path.join(active.path, "file-link"))
          })
          const authorization = Layer.mock(PermissionV2.Service, {
            assert: (input) => {
              expect(input.action).toBe("glob")
              return Effect.void
            },
          })
          yield* withTool(
            active.path,
            (registry) =>
              Effect.gen(function* () {
                yield* Effect.forEach(
                  ["escape", "escape/private.txt", "escape/missing", "file-link", path.join(active.path, "escape")],
                  (target) =>
                    Effect.gen(function* () {
                      const result = yield* settleTool(
                        registry,
                        call({ pattern: "*", path: RelativePath.make(target) }, `call-path-${target}`),
                      )
                      expect(result.result).toMatchObject({
                        type: "error",
                        value: expect.stringContaining("location_escape"),
                      })
                    }),
                )
                yield* Effect.forEach([".", "inside", path.join(active.path, "inside")], (target) =>
                  Effect.gen(function* () {
                    const result = yield* settleTool(
                      registry,
                      call({ pattern: "*", path: RelativePath.make(target) }, `call-path-${target}`),
                    )
                    expect(result.result.type).toBe("text")
                    expect(result.result.type === "text" ? result.result.value : "").toContain("local.txt")
                    expect(result.result.type === "text" ? result.result.value : "").not.toContain("private.txt")
                    expect(result.result.type === "text" ? result.result.value : "").not.toContain("PRIVATE")
                  }),
                )
              }),
            authorization,
          )
        }),
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )

  // The read tool's boundary applies to search too: otherwise a glob lists any directory.
  it.live("keeps the listing inside the Location unless external_directory is approved", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        withTool(active.path, (registry) =>
          Effect.gen(function* () {
            assertions.length = 0
            guard.allowExternal = false
            yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "outside-secret.txt"), "x\n"))
            yield* Effect.promise(() => fs.symlink(outside.path, path.join(active.path, "link")))

            const relative = yield* settleTool(
              registry,
              call(
                { pattern: "*", path: RelativePath.make(path.relative(active.path, outside.path)) },
                "call-relative",
              ),
            )
            expect(relative.result).toMatchObject({ type: "error", value: expect.stringContaining("relative_escape") })
            const symlink = yield* settleTool(
              registry,
              call({ pattern: "*", path: RelativePath.make("link") }, "call-symlink"),
            )
            expect(symlink.result).toMatchObject({ type: "error", value: expect.stringContaining("location_escape") })
            expect(assertions).toEqual([])

            const denied = yield* settleTool(
              registry,
              call({ pattern: "*", path: RelativePath.make(outside.path) }, "call-absolute"),
            )
            expect(denied.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("Permission denied: glob"),
            })
            expect(assertions).toMatchObject([{ sessionID, action: "external_directory" }])
            expect(assertions[0]?.resources[0]).toEndWith("/*")

            guard.allowExternal = true
            const approved = yield* settleTool(
              registry,
              call({ pattern: "*", path: RelativePath.make(outside.path) }, "call-approved"),
            )
            expect(approved.result.type === "text" ? approved.result.value : "").toContain("outside-secret.txt")
            expect(assertions.slice(1).map((input) => input.action)).toEqual(["external_directory", "glob"])
          }),
        ),
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )
})
