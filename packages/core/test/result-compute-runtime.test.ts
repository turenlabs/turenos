import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ResultComputeRuntime } from "@turenlabs/core/tool/result-compute-runtime"
import { Cause, Effect, Fiber, Schema } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(ResultComputeRuntime.node))

describe("ResultComputeRuntime", () => {
  it.live("aggregates only the supplied retained JSON data", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      const result = yield* runtime.run({
        code: "return { count: data.filter(row => row.failed).length, total: data.reduce((sum, row) => sum + row.value, 0) }",
        data: [
          { failed: true, value: 4 },
          { failed: false, value: 8 },
          { failed: true, value: 16 },
        ],
      })
      expect(result).toEqual({ ok: true, value: { count: 2, total: 28 }, toolCalls: [] })
      const hostile = '"}; return process.env; //\n\u2028'
      expect(yield* runtime.run({ code: "return data.value", data: { value: hostile } })).toEqual({
        ok: true,
        value: hostile,
        toolCalls: [],
      })
      const prototype = yield* runtime.run({ code: "return data", data: { ["__proto__"]: { value: "data" } } })
      expect(prototype.ok).toBe(false)
    }),
  )

  it.live(
    "denies process, filesystem, network, dynamic code, and host tool access",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ResultComputeRuntime.Service
        for (const code of [
          "return process.env",
          "return Bun.file('/etc/passwd').text()",
          "return await fetch('https://example.invalid')",
          "return require('node:fs').readFileSync('/etc/passwd', 'utf8')",
          "return await import('node:fs')",
          "return eval('1 + 1')",
          "return Function('return process')()",
          "return data.constructor.constructor('return process')()",
          "return await tools.read({ path: '/etc/passwd' })",
        ]) {
          const result = yield* runtime.run({ code, data: {} })
          expect(result.ok).toBe(false)
          expect(result.toolCalls).toEqual([])
        }
      }),
    15_000,
  )

  it.live("bounds code and serialized data before starting computation", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      expect(
        yield* runtime
          .run({ code: "é".repeat(ResultComputeRuntime.maxCodeBytes / 2 + 1), data: null })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ResultComputeError", message: "Computation code exceeds the 16 KiB limit." })
      expect(
        yield* runtime
          .run({ code: "return data", data: "a".repeat(ResultComputeRuntime.maxDataBytes) })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "ResultComputeError",
        message: "Computation data exceeds its JSON size or complexity limit.",
      })
    }),
  )

  it.live("preflights deeply nested and shared input before host JSON serialization", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      const inputs: Schema.Json[] = [null, null]
      Array.from({ length: 20_000 }).forEach(() => {
        inputs[0] = [inputs[0]]
      })
      Array.from({ length: 40 }).forEach(() => {
        inputs[1] = [inputs[1], inputs[1]]
      })
      for (const data of inputs) {
        const result = yield* runtime.run({ code: "return data", data }).pipe(Effect.flip)
        expect(result).toMatchObject({
          _tag: "ResultComputeError",
          message: "Computation data exceeds its JSON size or complexity limit.",
        })
      }
    }),
  )

  it.live("bounds the complete result and log envelope including escaped UTF-8", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      for (const code of [
        "return data",
        "console.log(data); return { count: data.length }",
        "console.log(data); throw new Error(data)",
      ]) {
        const result = yield* runtime.run({ code, data: '☃\u0000"\\'.repeat(3000) })
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(ResultComputeRuntime.maxOutputBytes)
        expect(result.truncated).toBe(true)
      }
    }),
  )

  it.live("reports malformed programs and sanitizes unexpected execution failures", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      const malformed = yield* runtime.run({ code: "return (", data: {} })
      expect(malformed.ok).toBe(false)
      if (!malformed.ok) expect(malformed.error.kind).toBe("ParseError")
      const thrown = yield* runtime.run({ code: "throw new Error(data)", data: "host-secret /Users/private/secret" })
      expect(thrown).toEqual({
        ok: false,
        error: { kind: "ExecutionFailure", message: "Program execution failed." },
        toolCalls: [],
      })
    }),
  )

  it.live(
    "times out infinite interpreted loops and can immediately run another request",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ResultComputeRuntime.Service
        const started = Date.now()
        const result = yield* runtime.run({ code: "while (true) {}", data: null }).pipe(Effect.result)
        expect(Date.now() - started).toBeLessThan(ResultComputeRuntime.wallTimeoutMs + 1500)
        if (result._tag === "Success") {
          expect(result.success.ok).toBe(false)
          if (!result.success.ok)
            expect(["TimeoutExceeded", "ResourceLimitExceeded"]).toContain(result.success.error.kind)
        }
        if (result._tag === "Failure") expect(result.failure.message).toContain("wall-clock limit")
        expect(yield* runtime.run({ code: "return data + 1", data: 41 })).toEqual({
          ok: true,
          value: 42,
          toolCalls: [],
        })
      }),
    10_000,
  )

  it.live("rejects large intermediate allocation before native array amplification", () =>
    Effect.gen(function* () {
      const runtime = yield* ResultComputeRuntime.Service
      const result = yield* runtime.run({ code: "return Array.from({ length: 20000000 }).length", data: null })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe("ResourceLimitExceeded")
      expect(yield* runtime.run({ code: "return 42", data: null })).toEqual({ ok: true, value: 42, toolCalls: [] })
    }),
  )

  it.live(
    "processes a bounded retained text value close to the 8 MiB input limit",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ResultComputeRuntime.Service
        const data = "a".repeat(ResultComputeRuntime.maxDataBytes - 4096)
        expect(yield* runtime.run({ code: "return data.length", data })).toEqual({
          ok: true,
          value: data.length,
          toolCalls: [],
        })
        expect(yield* runtime.run({ code: 'return data.split("\\n").length', data })).toEqual({
          ok: true,
          value: 1,
          toolCalls: [],
        })
      }),
    10_000,
  )

  it.live(
    "isolates native regexp operations from the parent event loop",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ResultComputeRuntime.Service
        const started = Date.now()
        const stalled = yield* runtime
          .run({ code: "return /(a+)+$/.test(data)", data: `${"a".repeat(40)}!` })
          .pipe(Effect.result, Effect.forkChild)
        yield* Effect.sleep(50)
        expect(Date.now() - started).toBeLessThan(1000)
        const result = yield* Fiber.join(stalled)
        expect(Date.now() - started).toBeLessThan(ResultComputeRuntime.wallTimeoutMs + 1500)
        if (result._tag === "Failure") expect(result.failure.message).toContain("wall-clock limit")
        if (result._tag === "Success") {
          // JSC can bound regexp backtracking internally and return false before our deadline.
          if (result.success.ok) expect(result.success.value).toBe(false)
          if (!result.success.ok) expect(["ExecutionFailure", "TimeoutExceeded"]).toContain(result.success.error.kind)
        }
        expect(yield* runtime.run({ code: "return data", data: "recovered" })).toEqual({
          ok: true,
          value: "recovered",
          toolCalls: [],
        })
      }),
    10_000,
  )

  it.live(
    "terminates cancelled work before releasing the worker permit",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ResultComputeRuntime.Service
        const running = yield* runtime
          .run({ code: "return /(a+)+$/.test(data)", data: `${"a".repeat(40)}!` })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(100)
        const started = Date.now()
        yield* Fiber.interrupt(running)
        const exit = yield* Fiber.await(running)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* runtime.run({ code: "return 42", data: null })).toEqual({ ok: true, value: 42, toolCalls: [] })
        expect(Date.now() - started).toBeLessThan(2000)
      }),
    10_000,
  )

  test.skipIf(!Bun.which("node"))(
    "bundled Node workers enforce wall timeout and reject invalid lifecycle outcomes",
    async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        `${tmp.path}/probe.ts`,
        `import { Effect } from ${JSON.stringify(fileURLToPath(import.meta.resolve("effect")))}
import { writeFile } from "node:fs/promises"
import { ResultComputeRuntime } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@turenlabs/core/tool/result-compute-runtime")))}
import { LayerNode } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@turenlabs/core/effect/layer-node")))}
await Effect.runPromise(Effect.gen(function* () {
  const runtime = yield* ResultComputeRuntime.Service
  const started = Date.now()
  const stalled = yield* runtime.run({ code: "return /(a+)+$/.test(data)", data: "a".repeat(40) + "!" }).pipe(Effect.result)
  const elapsed = Date.now() - started
  const recovered = yield* runtime.run({ code: "return data + 1", data: 41 })
  const outcomes = []
  for (const source of ["", 'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ unexpected: true })', 'throw new Error("host-secret /Users/private/secret")']) {
    yield* Effect.promise(() => writeFile(new URL("./result-compute-worker.js", import.meta.url), source))
    outcomes.push(yield* runtime.run({ code: "return 1", data: null }).pipe(Effect.result))
  }
  console.log(JSON.stringify({ stalled, elapsed, recovered, outcomes }))
}).pipe(Effect.provide(LayerNode.compile(ResultComputeRuntime.node))))
`,
      )
      const built = await Bun.build({
        entrypoints: [
          `${tmp.path}/probe.ts`,
          fileURLToPath(new URL("../src/tool/result-compute-worker.ts", import.meta.url)),
        ],
        outdir: tmp.path,
        naming: "[name].[ext]",
        target: "node",
        format: "esm",
      })
      expect(built.success).toBe(true)
      const child = Bun.spawn([Bun.which("node")!, `${tmp.path}/probe.js`], { stdout: "pipe", stderr: "pipe" })
      try {
        const output = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(output[1]).toBe("")
        expect(output[2]).toBe(0)
        const result = JSON.parse(output[0])
        expect(result.stalled).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("wall-clock limit") },
        })
        expect(result.elapsed).toBeGreaterThanOrEqual(ResultComputeRuntime.wallTimeoutMs - 50)
        expect(result.elapsed).toBeLessThan(ResultComputeRuntime.wallTimeoutMs + 1500)
        expect(result.recovered).toEqual({ ok: true, value: 42, toolCalls: [] })
        expect(result.outcomes).toHaveLength(3)
        expect(result.outcomes[0]).toMatchObject({
          _tag: "Failure",
          failure: { message: "Computation worker exited without a result." },
        })
        expect(result.outcomes[1]).toMatchObject({
          _tag: "Failure",
          failure: { message: "Invalid computation worker response." },
        })
        expect(result.outcomes[2]).toMatchObject({
          _tag: "Failure",
          failure: { message: "Computation worker failed." },
        })
        expect(output[0]).not.toMatch(/host-secret|\/Users\/private/)
      } finally {
        child.kill()
        await child.exited
      }
    },
    15_000,
  )
})
