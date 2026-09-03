import { expect, test } from "bun:test"
import { cp, mkdtemp, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildIndex, createYolkRuntime } from "@turenlabs/core/yolk"
import { YolkPlugin } from "@/plugin/yolk"

const fixture = path.join(import.meta.dir, "../yolk/fixtures/top10")

test("disabled Yolk contributes no tool or hooks", async () => {
  expect(await YolkPlugin({ directory: fixture }, { isEnabled: async () => false })).toEqual({})
})

test("inspect_change reports semantic impact and the write lifecycle reports changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-"))
  await cp(fixture, directory, { recursive: true })
  const hooks = await YolkPlugin({ directory }, { isEnabled: async () => true })
  const inspect = hooks.tool?.inspect_change
  expect(inspect).toBeDefined()

  const result = await inspect!.execute({ symbol: "typescript.auth.isInternal" }, {
    abort: new AbortController().signal,
  } as never)
  expect(typeof result).toBe("object")
  if (typeof result === "string") throw new Error("Yolk returned an unexpected string result")
  expect(JSON.parse(result.output).semantic_equivalents).toHaveLength(7)

  const auth = path.join(directory, "typescript/auth.ts")
  await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "session", callID: "call" }, { args: {} })
  await Bun.write(auth, (await Bun.file(auth).text()).replace("@corp.com", "@external.com"))
  const output = { title: "", output: "edited", metadata: {} }
  await hooks["tool.execute.after"]?.({ tool: "edit", sessionID: "session", callID: "call", args: {} }, output)

  expect(output.output).toContain("Yolk semantic change check")
  expect(output.output).toContain("typescript.auth.isInternal: semantic-change")
  expect(output.metadata).toHaveProperty("yolk.semantic_changes", 1)
  await hooks.dispose?.()
})

test("post-edit checking works without a prior inspect_change call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-automatic-"))
  await cp(fixture, directory, { recursive: true })
  const hooks = await YolkPlugin({ directory }, { isEnabled: async () => true })
  await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "session", callID: "call" }, { args: {} })

  const auth = path.join(directory, "typescript/auth.ts")
  await Bun.write(auth, (await Bun.file(auth).text()).replace("@corp.com", "@external.com"))
  const output = { title: "", output: "edited", metadata: {} }
  await hooks["tool.execute.after"]?.({ tool: "edit", sessionID: "session", callID: "call", args: {} }, output)

  expect(output.output).toContain("typescript.auth.isInternal: semantic-change")
  expect(output.output).toContain("HIGH risk")
  expect(output.output).toContain("Recommended:")
  await hooks.dispose?.()
})

test("failed mutations report semantic changes when partial writes remain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-error-"))
  await cp(fixture, directory, { recursive: true })
  const hooks = await YolkPlugin({ directory }, { isEnabled: async () => true })
  await hooks["tool.execute.before"]?.({ tool: "apply_patch", sessionID: "session", callID: "partial" }, { args: {} })
  const auth = path.join(directory, "typescript/auth.ts")
  await Bun.write(auth, (await Bun.file(auth).text()).replace("@corp.com", "@partial.com"))
  const output = { error: new Error("later operation failed"), message: "later operation failed" }
  await hooks["tool.execute.error"]?.(
    { tool: "apply_patch", sessionID: "session", callID: "partial", args: {} },
    output,
  )

  expect(output.message).toContain("later operation failed")
  expect(output.message).toContain("Yolk semantic change check")
  await hooks.dispose?.()
})

test("inspect_change forwards tool cancellation to indexing", async () => {
  const controller = new AbortController()
  const hooks = await YolkPlugin(
    { directory: fixture },
    {
      isEnabled: async () => true,
      build: async (_root, options) => {
        options?.signal?.throwIfAborted()
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
        })
      },
    },
  )
  const inspection = hooks.tool!.inspect_change!.execute({ symbol: "typescript.auth.isInternal" }, {
    abort: controller.signal,
  } as never)
  controller.abort(new Error("cancelled"))

  await expect(inspection).rejects.toThrow("cancelled")
  await hooks.dispose?.()
})

test("concurrent call baselines are retained until their matching after hook", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-concurrent-"))
  await cp(fixture, directory, { recursive: true })
  const state = { builds: 0 }
  const hooks = await YolkPlugin(
    { directory },
    {
      isEnabled: async () => true,
      build: async (root, options) => {
        state.builds++
        await Bun.sleep(10)
        return buildIndex(root, options)
      },
    },
  )
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: `session-${index}`, callID: `call-${index}` },
        { args: {} },
      ),
    ),
  )
  expect(state.builds).toBe(1)

  const auth = path.join(directory, "typescript/auth.ts")
  await Bun.write(auth, (await Bun.file(auth).text()).replace("@corp.com", "@external.com"))
  const output = { title: "", output: "edited", metadata: {} }
  await hooks["tool.execute.after"]?.({ tool: "edit", sessionID: "session-0", callID: "call-0", args: {} }, output)

  expect(output.output).toContain("typescript.auth.isInternal: semantic-change")
  expect(state.builds).toBe(2)
  await hooks.dispose?.()
})

test("discarding a failed mutation invalidates symbol discovery cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-discard-"))
  const file = path.join(directory, "value.ts")
  await Bun.write(file, "export function beforeFailure() { return true }\n")
  const runtime = createYolkRuntime(directory)
  await runtime.inspect({ symbol: "value.beforeFailure" })
  await runtime.before("session:call")
  await Bun.write(file, "export function afterFailure() { return true }\n")
  runtime.discard("session:call")

  const discovery = await runtime.inspect({ symbol: "value.afterFailure" })
  expect("target" in discovery ? discovery.target : undefined).toBe("value.afterFailure")
  await runtime.dispose()
})

test("path-only discovery does not build the semantic graph", async () => {
  const runtime = createYolkRuntime(fixture, async () => {
    throw new Error("semantic graph should not build")
  })
  const discovery = await runtime.inspect({ paths: ["typescript/auth.ts", "python/auth.py"] })
  expect("symbols" in discovery ? discovery.symbols.map((item) => item.symbol) : []).toEqual([
    "python.auth.is_internal",
    "typescript.auth.isInternal",
  ])
  await runtime.dispose()
})

test("path-only discovery rejects symlinks outside the workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-path-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-path-outside-"))
  const target = path.join(outside, "secret.ts")
  await Bun.write(target, "export function outsideSecret() { return true }\n")
  await symlink(target, path.join(directory, "secret.ts"))
  const runtime = createYolkRuntime(directory)
  const discovery = await runtime.inspect({ path: "secret.ts" })
  expect("symbols" in discovery ? discovery.symbols : []).toEqual([])
  await runtime.dispose()
})

test("an interrupted post-edit snapshot invalidates symbol discovery cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-after-interrupt-"))
  const file = path.join(directory, "value.ts")
  await Bun.write(file, "export function beforeInterrupt() { return true }\n")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const state = { builds: 0 }
  const runtime = createYolkRuntime(directory, async (root, options) => {
    state.builds++
    if (state.builds === 2) {
      started.resolve()
      await release.promise
    }
    const index = await buildIndex(root, options)
    if (state.builds === 2) finished.resolve()
    return index
  })
  await runtime.inspect({ symbol: "value.beforeInterrupt" })
  await runtime.before("session:call")
  await Bun.write(file, "export function afterInterrupt() { return true }\n")
  const controller = new AbortController()
  const comparison = runtime.after("session:call", controller.signal)
  await started.promise
  controller.abort(new Error("cancelled"))
  await expect(comparison).rejects.toThrow("cancelled")
  release.resolve()
  await finished.promise
  await Bun.sleep(0)

  const discovery = await runtime.inspect({ symbol: "value.afterInterrupt" })
  expect("target" in discovery ? discovery.target : undefined).toBe("value.afterInterrupt")
  expect(state.builds).toBe(3)
  await runtime.dispose()
})

test("invalidated concurrent snapshots never join a pre-change build", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-generation-"))
  await Bun.write(path.join(directory, "value.ts"), "export function value() { return true }\n")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const state = { builds: 0 }
  const runtime = createYolkRuntime(directory, async (root, options) => {
    state.builds++
    if (state.builds === 2) {
      started.resolve()
      await release.promise
    }
    return buildIndex(root, options)
  })
  await Promise.all([runtime.before("first"), runtime.before("second")])
  const first = runtime.after("first")
  await started.promise
  runtime.invalidate(["value.ts"])
  const second = runtime.after("second")
  release.resolve()
  await Promise.all([first, second])

  expect(state.builds).toBe(3)
  await runtime.dispose()
})

test("repeated inspection reuses a completed index until invalidation", async () => {
  const state = { builds: 0 }
  const runtime = createYolkRuntime(fixture, async (root, options) => {
    state.builds++
    return buildIndex(root, options)
  })

  await runtime.inspect({ symbol: "typescript.auth.isInternal" })
  await runtime.inspect({ symbol: "typescript.permissions.canAccess" })
  expect(state.builds).toBe(1)

  runtime.invalidate(["typescript/auth.ts"])
  await runtime.inspect({ symbol: "typescript.auth.isInternal" })
  expect(state.builds).toBe(2)
  await runtime.dispose()
})

test("external watcher events invalidate completed inspection snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-watcher-"))
  const file = path.join(directory, "value.ts")
  await Bun.write(file, "export function beforeWatcher() { return true }\n")
  const hooks = await YolkPlugin({ directory }, { isEnabled: async () => true })
  const inspect = hooks.tool!.inspect_change!
  const first = await inspect.execute({ symbol: "value.beforeWatcher" }, {
    abort: new AbortController().signal,
  } as never)
  expect(JSON.stringify(first)).toContain("value.beforeWatcher")

  await Bun.write(file, "export function afterWatcher() { return true }\n")
  await hooks.event?.({
    event: {
      id: "evt_yolk_watcher",
      type: "file.watcher.updated",
      properties: { file, event: "change" },
    },
  })
  const second = await inspect.execute({ symbol: "value.afterWatcher" }, {
    abort: new AbortController().signal,
  } as never)
  expect(JSON.stringify(second)).toContain("value.afterWatcher")
  await hooks.dispose?.()
})

test("path discovery reports malformed and oversized files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-discovery-health-"))
  await Promise.all([
    Bun.write(path.join(directory, "valid.ts"), "export function valid() { return true }\n"),
    Bun.write(path.join(directory, "broken.ts"), 'export function broken() { return "unterminated\n'),
    Bun.write(path.join(directory, "large.ts"), Buffer.alloc(8 * 1024 * 1024 + 1, 32)),
  ])
  const runtime = createYolkRuntime(directory)
  const report = await runtime.inspect({ path: "." })
  if (!("symbols" in report)) throw new Error("expected discovery report")

  expect(report.symbols.map((item) => item.symbol)).toContain("valid.valid")
  expect(report.index_diagnostics.join("\n")).toContain("broken.ts")
  expect(report.index_diagnostics.join("\n")).toContain("large.ts")
  expect(report.discovery).toMatchObject({ filesSeen: 3, filesParsed: 1, filesSkipped: 2 })
  await runtime.dispose()
})

test("batch lookup does not restrict unresolved symbols to the first path", async () => {
  const runtime = createYolkRuntime(fixture)
  const report = await runtime.inspect({
    symbols: ["isIntern", "canAccess"],
    paths: ["typescript/auth.ts", "typescript/permissions.ts"],
  })
  if (!("mode" in report)) throw new Error("expected batch report")

  expect(report.unresolved.flatMap((item) => item.symbols.map((symbol) => symbol.symbol))).toEqual([
    "typescript.auth.isInternal",
    "typescript.permissions.canAccess",
  ])
  await runtime.dispose()
})

test("path discovery caps and deduplicates requested roots before traversal", async () => {
  const runtime = createYolkRuntime(fixture)
  const duplicate = await runtime.inspect({ paths: Array.from({ length: 500 }, () => "typescript/auth.ts") })
  if (!("symbols" in duplicate)) throw new Error("expected discovery report")
  expect(duplicate.symbols.map((item) => item.symbol)).toEqual(["typescript.auth.isInternal"])
  expect(duplicate.discovery).toMatchObject({ filesSeen: 1, truncated: false })
  await runtime.dispose()

  const directory = await mkdtemp(path.join(os.tmpdir(), "yolk-plugin-path-limit-"))
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      Bun.write(path.join(directory, `value-${index}.ts`), `export function value${index}() { return true }\n`),
    ),
  )
  const limitedRuntime = createYolkRuntime(directory)
  const limited = await limitedRuntime.inspect({
    paths: Array.from({ length: 101 }, (_, index) => `value-${index}.ts`),
  })
  if (!("symbols" in limited)) throw new Error("expected discovery report")
  expect(limited.discovery?.truncated).toBe(true)
  expect(limited.index_diagnostics.join("\n")).toContain("path discovery input limit")
  await limitedRuntime.dispose()
})
