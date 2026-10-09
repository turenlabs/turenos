import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { GrepTool } from "@turenlabs/core/tool/grep"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"
import { ShellToolRouting } from "@turenlabs/core/shell-tool-routing"

const sessionID = SessionV2.ID.make("ses_grep_tool_test")
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
    const registry = yield* ToolRegistry.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
        [PermissionV2.node, authorization],
        ...(backend ? [[Ripgrep.node, backend] as const] : []),
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
  it.live("reports a failing backend so bash stops redirecting searches to it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const state = { fail: true }
        const real = Ripgrep.Service.of({
          find: () => Effect.succeed([]),
          glob: () => Effect.succeed([]),
          lines: () => Effect.succeed(new Map()),
          grep: () => Effect.succeed([]),
        })
        const backend = Layer.succeed(
          Ripgrep.Service,
          Ripgrep.Service.of({
            ...real,
            grep: (input) =>
              state.fail ? Effect.fail(new Ripgrep.Error({ message: "worker trapped" })) : real.grep(input),
          }),
        )
        return withTool(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              const failed = yield* executeTool(registry, call("call-failing", { pattern: "x" }))
              expect(failed).toMatchObject({ type: "error", value: expect.stringContaining("worker trapped") })
              expect(ShellToolRouting.searchUnavailable(sessionID, "grep")).toBe(true)
              state.fail = false
              yield* executeTool(registry, call("call-recovered", { pattern: "x" }))
              expect(ShellToolRouting.searchUnavailable(sessionID, "grep")).toBe(false)
            }),
          permission,
          backend,
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

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

  it.live("searches the authorized canonical target if an alias changes during approval", () =>
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
            await fs.writeFile(path.join(approved, "data.txt"), "APPROVED\n")
            await fs.writeFile(path.join(denied, "data.txt"), "UNAUTHORIZED\n")
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
                const result = yield* executeTool(registry, call("call-swapped", { pattern: ".", path: alias }))
                expect(result.type).toBe("text")
                expect(result.type === "text" ? result.value : "").toContain("APPROVED")
                expect(result.type === "text" ? result.value : "").not.toContain("UNAUTHORIZED")
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
        Effect.forEach(["external_directory", "grep"], (action) => {
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
                const result = yield* executeTool(
                  registry,
                  call(`call-denied-${action}`, { pattern: ".", path: outside.path }),
                )
                expect(result).toMatchObject({
                  type: "error",
                  value: expect.stringContaining("Permission denied: grep"),
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
              expect(input.action).toBe("grep")
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
                      const result = yield* executeTool(
                        registry,
                        call(`call-path-${target}`, { pattern: ".", path: target }),
                      )
                      expect(result).toMatchObject({ type: "error", value: expect.stringContaining("location_escape") })
                    }),
                )
                yield* Effect.forEach([".", "inside", path.join(active.path, "inside"), "inside/local.txt"], (target) =>
                  Effect.gen(function* () {
                    const result = yield* executeTool(
                      registry,
                      call(`call-path-${target}`, { pattern: ".", path: target }),
                    )
                    expect(result.type).toBe("text")
                    expect(result.type === "text" ? result.value : "").toContain("local.txt")
                    expect(result.type === "text" ? result.value : "").not.toContain("private.txt")
                    expect(result.type === "text" ? result.value : "").not.toContain("PRIVATE")
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

  // The read tool's boundary applies to search too: otherwise a grep for `.` reads any file.
  it.live("keeps the search inside the Location unless external_directory is approved", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        withTool(active.path, (registry) =>
          Effect.gen(function* () {
            assertions.length = 0
            guard.allowExternal = false
            const secret = path.join(outside.path, "secret.txt")
            yield* Effect.promise(() => fs.writeFile(secret, "SECRETMATERIAL\n"))
            yield* Effect.promise(() => fs.symlink(outside.path, path.join(active.path, "link")))

            const relative = yield* executeTool(
              registry,
              call("call-relative", { pattern: "SECRET", path: path.relative(active.path, outside.path) }),
            )
            expect(relative).toMatchObject({ type: "error", value: expect.stringContaining("relative_escape") })
            const symlink = yield* executeTool(registry, call("call-symlink", { pattern: "SECRET", path: "link" }))
            expect(symlink).toMatchObject({ type: "error", value: expect.stringContaining("location_escape") })
            expect(assertions).toEqual([])

            const denied = yield* executeTool(
              registry,
              call("call-absolute", { pattern: "SECRET", path: outside.path }),
            )
            // The model-visible message redacts the external path itself.
            expect(denied).toMatchObject({ type: "error", value: expect.stringContaining("Permission denied: grep") })
            expect(assertions).toMatchObject([{ sessionID, action: "external_directory" }])
            expect(assertions[0]?.resources[0]).toEndWith("/*")

            guard.allowExternal = true
            const approved = yield* executeTool(
              registry,
              call("call-approved", { pattern: "SECRET", path: outside.path }),
            )
            expect(approved.type).toBe("text")
            expect(approved.type === "text" ? approved.value : "").toContain("SECRETMATERIAL")
            expect(assertions.slice(1).map((input) => input.action)).toEqual(["external_directory", "grep"])

            assertions.length = 0
            guard.allowExternal = false
            const deniedFile = yield* executeTool(registry, call("call-file-denied", { pattern: ".", path: secret }))
            expect(deniedFile).toMatchObject({
              type: "error",
              value: expect.stringContaining("Permission denied: grep"),
            })
            expect(assertions[0]?.resources).toEqual([`${outside.path.replaceAll("\\", "/")}/*`])
            guard.allowExternal = true
            const approvedFile = yield* executeTool(
              registry,
              call("call-file-approved", { pattern: ".", path: secret }),
            )
            expect(approvedFile.type === "text" ? approvedFile.value : "").toContain("SECRETMATERIAL")
          }),
        ),
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )
})
