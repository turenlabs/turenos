import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { RipgrepWasm } from "@turenlabs/core/ripgrep/wasm"
import { startPool, WASM_FLAGS } from "@turenlabs/core/ripgrep/wasm/runtime"

// Force the spawned-rg path for the comparison service so both implementations
// run side by side.
process.env.FORGE_RIPGREP_WASM = "0"

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "rgwasm-test-"))
const w = (p: string, body: string | Buffer) => {
  const f = path.join(fixture, p)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, body)
}
w(".git/HEAD", "ref: refs/heads/main\n")
w(".gitignore", "ignored-dir/\n*.log\n")
w("ignored-dir/x.ts", "foo ignored\n")
w("drop.log", "foo log\n")
w("a.ts", "const foo = 1\nlet bar = foo\n")
w("sub/b.ts", "foo sub\nnested foo\n")
w("sub/c.md", "foo doc\n")
w("bin.dat", Buffer.concat([Buffer.from("foo before\n"), Buffer.from([0])]))
w("nonewline.txt", "foo tail")
// Windows denies symlink creation without developer mode/admin.
let hasSymlinks = false
if (process.platform !== "win32") {
  try {
    fs.symlinkSync("a.ts", path.join(fixture, "link.ts"))
    fs.symlinkSync("sub", path.join(fixture, "linkdir"))
    hasSymlinks = true
  } catch {}
}

const nativeLayer = LayerNode.compile(Ripgrep.node)
const wasmLayer = LayerNode.compile(RipgrepWasm.node)

const runNative = <A>(fn: (r: Ripgrep.Interface) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const r = yield* Ripgrep.Service
      return yield* fn(r)
    }).pipe(Effect.provide(nativeLayer)),
  )

const runWasm = <A>(fn: (r: Ripgrep.Interface) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const w = yield* RipgrepWasm.Service
      return yield* fn(w.iface)
    }).pipe(Effect.provide(wasmLayer)),
  )

describe("ripgrep wasm", () => {
  test("service resolves and is enabled", async () => {
    const wasm = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* RipgrepWasm.Service
      }).pipe(Effect.provide(wasmLayer)),
    )
    expect(wasm.enabled).toBe(true)
  })

  test("find matches native", async () => {
    const input = { cwd: fixture, pattern: "*", limit: 100, hidden: true }
    const expected = await runNative((r) => r.find(input))
    const got = await runWasm((r) => r.find(input))
    expect(got.map((e) => e.path).sort()).toEqual(expected.map((e) => e.path).sort())
  })

  test("find honors hidden=false", async () => {
    const input = { cwd: fixture, pattern: "*", limit: 100, hidden: false }
    const expected = await runNative((r) => r.find(input))
    const got = await runWasm((r) => r.find(input))
    expect(got.map((e) => e.path).sort()).toEqual(expected.map((e) => e.path).sort())
    expect(got.every((e) => !e.path.startsWith("."))).toBe(true)
  })

  if (hasSymlinks) {
    test("find with follow matches native", async () => {
      const input = { cwd: fixture, pattern: "*", limit: 100, hidden: true, follow: true }
      const expected = await runNative((r) => r.find(input))
      const got = await runWasm((r) => r.find(input))
      expect(got.map((e) => e.path).sort()).toEqual(expected.map((e) => e.path).sort())
      // linkdir resolves through the symlink under --follow
      expect(got.some((e) => e.path.startsWith("linkdir/"))).toBe(true)
    })
  }

  test("glob matches native", async () => {
    const input = { cwd: fixture, pattern: "*.ts", limit: 100, hidden: true }
    const expected = await runNative((r) => r.glob(input))
    const got = await runWasm((r) => r.glob(input))
    expect(got.map((e) => e.path).sort()).toEqual(expected.map((e) => e.path).sort())
  })

  test("lines matches native", async () => {
    const files = ["a.ts", "sub/b.ts", "nonewline.txt", "bin.dat"]
    const expected = await runNative((r) => r.lines({ cwd: fixture, files }))
    const got = await runWasm((r) => r.lines({ cwd: fixture, files }))
    for (const f of files) expect(got.get(f)).toBe(expected.get(f))
  })

  test("grep matches native", async () => {
    const input = { cwd: fixture, pattern: "foo", limit: 100 }
    const expected = await runNative((r) => r.grep(input))
    const got = await runWasm((r) => r.grep(input))
    const key = (m: any) =>
      `${m.entry.path}:${m.line}:${m.offset}:${m.text}:${m.submatches.map((s: any) => `${s.start},${s.end},${s.text}`).join(";")}`
    expect(got.map(key).sort()).toEqual(expected.map(key).sort())
  })

  test("grep with include glob matches native", async () => {
    const input = { cwd: fixture, pattern: "foo", include: "*.ts", limit: 100 }
    const expected = await runNative((r) => r.grep(input))
    const got = await runWasm((r) => r.grep(input))
    expect(got.map((m) => m.entry.path).sort()).toEqual(expected.map((m) => m.entry.path).sort())
    expect(got.every((m) => m.entry.path.endsWith(".ts"))).toBe(true)
  })

  // The host hands file contents to the wasm side in bounded batches (8 MiB). A
  // candidate list larger than one batch used to trap or silently drop every file
  // after the first batch, so the needles sit at the start, middle and end.
  describe("candidate sets larger than one read batch", () => {
    const large = fs.mkdtempSync(path.join(os.tmpdir(), "rgwasm-large-"))
    const filler = `${"lorem ipsum dolor sit amet ".repeat(19)}\n`.repeat(1_000)
    const count = 40
    const needles = new Set([0, count / 2, count - 1])
    for (let index = 0; index < count; index++) {
      const name = path.join(large, `file-${String(index).padStart(2, "0")}.txt`)
      fs.writeFileSync(name, needles.has(index) ? `${filler}needle ${index}\n` : filler)
    }
    const expected = [...needles].map((index) => `file-${String(index).padStart(2, "0")}.txt`).sort()

    test("one worker finds every match across batches", async () => {
      const pool = startPool(1)
      try {
        const result = await pool.grep("needle", large, [], WASM_FLAGS.hidden, 0, undefined)
        expect(result.matches.map((match) => path.basename(match.path)).sort()).toEqual(expected)
      } finally {
        await pool.stop()
      }
    })

    test("grep matches native", async () => {
      const input = { cwd: large, pattern: "needle", limit: 100 }
      const native = await runNative((r) => r.grep(input))
      const got = await runWasm((r) => r.grep(input))
      expect(native.map((match) => String(match.entry.path)).sort()).toEqual(expected)
      expect(got.map((match) => String(match.entry.path)).sort()).toEqual(expected)
    })
  })

  describe("per-job fallback", () => {
    const trapped = new Ripgrep.Error({ message: "ripgrep wasm grep failed: Unreachable code should not be executed" })
    const failing: Ripgrep.Interface = {
      find: () => Effect.fail(trapped),
      glob: () => Effect.fail(trapped),
      lines: () => Effect.fail(trapped),
      grep: () => Effect.fail(trapped),
    }
    const counting = (calls: string[]): Ripgrep.Interface => ({
      find: () => Effect.sync(() => void calls.push("find")).pipe(Effect.as([])),
      glob: () => Effect.sync(() => void calls.push("glob")).pipe(Effect.as([])),
      lines: () => Effect.sync(() => void calls.push("lines")).pipe(Effect.as(new Map())),
      grep: () => Effect.sync(() => void calls.push("grep")).pipe(Effect.as([])),
    })

    test("a failed wasm job is answered by the rg binary", async () => {
      const input = { cwd: fixture, pattern: "foo", limit: 100 }
      const expected = await runNative((r) => r.grep(input))
      const got = await runNative((native) => Ripgrep.withFallback(failing, native).grep(input))
      expect(got.map((m) => `${m.entry.path}:${m.line}`).sort()).toEqual(
        expected.map((m) => `${m.entry.path}:${m.line}`).sort(),
      )
      expect(got.length).toBeGreaterThan(0)
    })

    test("every operation falls back", async () => {
      const calls: string[] = []
      const service = Ripgrep.withFallback(failing, counting(calls))
      await Effect.runPromise(service.find({ cwd: fixture, pattern: "*", limit: 10 }))
      await Effect.runPromise(service.glob({ cwd: fixture, pattern: "*", limit: 10 }))
      await Effect.runPromise(service.lines({ cwd: fixture, files: ["a.ts"] }))
      await Effect.runPromise(service.grep({ cwd: fixture, pattern: "foo", limit: 10 }))
      expect(calls).toEqual(["find", "glob", "lines", "grep"])
    })

    test("an invalid pattern is an answer, not a backend failure", async () => {
      const calls: string[] = []
      const invalid: Ripgrep.Interface = {
        ...failing,
        grep: (input) => Effect.fail(new Ripgrep.InvalidPatternError({ pattern: input.pattern, message: "regex parse error" })),
      }
      const exit = await Effect.runPromiseExit(
        Ripgrep.withFallback(invalid, counting(calls)).grep({ cwd: fixture, pattern: "(", limit: 10 }),
      )
      expect(exit._tag).toBe("Failure")
      expect(calls).toEqual([])
    })

    test("an aborted job is not retried", async () => {
      const calls: string[] = []
      const controller = new AbortController()
      controller.abort()
      const exit = await Effect.runPromiseExit(
        Ripgrep.withFallback(failing, counting(calls)).grep({
          cwd: fixture,
          pattern: "foo",
          limit: 10,
          signal: controller.signal,
        }),
      )
      expect(exit._tag).toBe("Failure")
      expect(calls).toEqual([])
    })
  })

  test("grep invalid pattern fails", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const w = yield* RipgrepWasm.Service
        return yield* w.iface.grep({ cwd: fixture, pattern: "(", limit: 10 })
      }).pipe(Effect.provide(wasmLayer)),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("grep on a file path matches native", async () => {
    const input = { cwd: fixture, pattern: "foo", file: "sub/b.ts", limit: 100 }
    const expected = await runNative((r) => r.grep(input))
    const got = await runWasm((r) => r.grep(input))
    expect(got.map((m) => `${m.entry.path}:${m.line}`).sort()).toEqual(
      expected.map((m) => `${m.entry.path}:${m.line}`).sort(),
    )
    expect(got.every((m) => m.entry.path === "sub/b.ts")).toBe(true)
  })

  test("lines omits a missing file like native", async () => {
    const files = ["a.ts", "does-not-exist.txt"]
    const expected = await runNative((r) => r.lines({ cwd: fixture, files }))
    const got = await runWasm((r) => r.lines({ cwd: fixture, files }))
    expect([...got.keys()].sort()).toEqual([...expected.keys()].sort())
    expect(got.get("does-not-exist.txt")).toBeUndefined()
  })

  test("find honors limit", async () => {
    const got = await runWasm((r) => r.find({ cwd: fixture, pattern: "*", limit: 2, hidden: true }))
    expect(got.length).toBe(2)
  })

  test("find delivers every entry through onEntry", async () => {
    const seen: string[] = []
    const entries = await runWasm((r) =>
      r.find({
        cwd: fixture,
        pattern: "*",
        limit: 100,
        hidden: true,
        onEntry: (entry) => Effect.sync(() => void seen.push(entry.path)),
      }),
    )
    expect(seen.sort()).toEqual(entries.map((e) => e.path).sort())
  })

  test("find on a missing directory fails like native", async () => {
    const run = (r: Ripgrep.Interface) =>
      r.find({ cwd: path.join(fixture, "nope"), pattern: "*", limit: 10 })
    const expected = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const r = yield* Ripgrep.Service
        return yield* run(r)
      }).pipe(Effect.provide(nativeLayer)),
    )
    const got = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const w = yield* RipgrepWasm.Service
        return yield* run(w.iface)
      }).pipe(Effect.provide(wasmLayer)),
    )
    expect(got._tag).toBe("Failure")
    expect(expected._tag).toBe("Failure")
  })

  test("aborted signal fails instead of returning partial results", async () => {
    const controller = new AbortController()
    controller.abort()
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const w = yield* RipgrepWasm.Service
        return yield* w.iface.find({ cwd: fixture, pattern: "*", limit: 100, signal: controller.signal })
      }).pipe(Effect.provide(wasmLayer)),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("ripgrep wasm fallback", () => {
  const build = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* RipgrepWasm.Service
      }).pipe(Effect.provide(RipgrepWasm.layer)),
    )

  test("missing asset disables the backend", async () => {
    process.env.FORGE_RIPGREP_WASM_ASSET = path.join(fixture, "nope.wasm")
    try {
      expect((await build()).enabled).toBe(false)
    } finally {
      delete process.env.FORGE_RIPGREP_WASM_ASSET
    }
  })

  test("corrupt asset disables the backend", async () => {
    const corrupt = path.join(fixture, "corrupt.wasm")
    fs.writeFileSync(corrupt, Buffer.from("not a wasm module"))
    process.env.FORGE_RIPGREP_WASM_ASSET = corrupt
    try {
      expect((await build()).enabled).toBe(false)
    } finally {
      delete process.env.FORGE_RIPGREP_WASM_ASSET
    }
  })

  test("a worker that dies before its first job fails the job instead of hanging", async () => {
    const pool = startPool(2, undefined, pathToFileURL(path.join(fixture, "missing-worker.js")))
    // Let every worker fail to load before any job is posted.
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const outcome = await Promise.race([
        pool.collect(fixture, [], WASM_FLAGS.hidden, 100, undefined).then(
          () => "resolved",
          (error: unknown) => String(error),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ])
      expect(outcome).toContain("ripgrep wasm worker failed")
    } finally {
      await pool.stop()
    }
  })
})
