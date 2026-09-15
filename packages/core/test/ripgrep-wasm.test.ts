import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { RipgrepWasm } from "@turenlabs/core/ripgrep/wasm"

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
})
