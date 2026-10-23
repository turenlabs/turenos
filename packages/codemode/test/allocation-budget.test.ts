import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"

const run = (code: string, limits: CodeMode.ExecutionLimits = {}) =>
  Effect.runPromise(
    CodeMode.execute({
      code,
      tools: {},
      limits: { maxAllocationBytes: 128 * 1024, maxOperations: 50_000, timeoutMs: 1000, ...limits },
    }),
  )

describe("CodeMode cumulative allocation budget", () => {
  test.each([
    ["array-like expansion", "return Array.from({ length: 10000 }).length"],
    ["sparse writes", "const a = []; a[10000] = 1; return a.length"],
    ["repeat", 'return "x".repeat(100000)'],
    ["padding", 'return "x".padStart(100000)'],
    ["join separators", 'return Array.from({ length: 32 }).join("x".repeat(10000))'],
    ["shared flattening", "let a = [1]; for (let i = 0; i < 16; i++) a = [a, a]; return a.flat(Infinity)"],
    [
      "callback flattening",
      "const a = Array.from({ length: 128 }); const b = Array.from({ length: 128 }); return a.flatMap(() => b)",
    ],
    ["concatenation", "let a = [1]; for (let i = 0; i < 20; i++) a = a.concat(a); return a.length"],
    ["binary strings", 'let a = "x"; for (let i = 0; i < 20; i++) a = a + a; return a.length'],
    ["template strings", 'let a = "x"; for (let i = 0; i < 20; i++) a = `${a}${a}`; return a.length'],
    ["JSON shared DAG", "let a = { x: 1 }; for (let i = 0; i < 16; i++) a = { a, b: a }; return JSON.stringify(a)"],
    ["return shared DAG", "let a = { x: 1 }; for (let i = 0; i < 16; i++) a = { a, b: a }; return a"],
    ["throw shared DAG", "let a = { x: 1 }; for (let i = 0; i < 16; i++) a = { a, b: a }; throw a"],
    ["console shared DAG", "let a = { x: 1 }; for (let i = 0; i < 16; i++) a = { a, b: a }; console.log(a); return 1"],
    ["JSON dense parsing", 'return JSON.parse("[" + "0,".repeat(1000) + "0]").length'],
    ["map growth", "const m = new Map(); for (let i = 0; i < 10000; i++) m.set(i, i); return m.size"],
    ["set growth", "const m = new Set(); for (let i = 0; i < 10000; i++) m.add(i); return m.size"],
    ["URL parameters", 'return new URLSearchParams("a=b&".repeat(1000)).size'],
    ["URI encoding", 'return encodeURIComponent("☃".repeat(12000))'],
    ["regular expression captures", 'return "a".repeat(2000).matchAll(/(a)/g)'],
    ["split overlapping captures", 'return "a".repeat(2000).split(/(?=(a+))/).length'],
    ["string-pattern captures", 'return "a".repeat(2000).matchAll("(a)".repeat(100))'],
    ["replacement overlapping captures", 'return "a".repeat(2000).replaceAll(/(?=(a+))/g, "$1")'],
    ["replacement prefix amplification", 'return "a".repeat(2000).replaceAll("a", "$`$\'")'],
    ["replacement callback collection", 'return "a".repeat(2000).replaceAll(/a/g, () => "b")'],
    [
      "URL assignment DAG",
      'let a = ["x"]; for(let i=0;i<12;i++) a=[a,a]; const u=new URL("https://example.invalid"); u.hash=a; return u.hash.length',
    ],
    ["update coercion DAG", 'let a = ["x"]; for(let i=0;i<16;i++) a=[a,a]; a++; return 1'],
    ["error coercion DAG", 'let a = ["x"]; for(let i=0;i<16;i++) a=[a,a]; return new Error(a)'],
    [
      "sort comparator coercion DAG",
      'return [2,1].sort(() => { let a = ["x"]; for(let i=0;i<16;i++) a=[a,a]; return a })',
    ],
    ["URI builtin callback", 'return ["☃".repeat(12000)].map(encodeURIComponent).length'],
    ["spread string materialization", 'return [..."x".repeat(4000)].length'],
    ["promise string materialization", 'return await Promise.all("x".repeat(4000))'],
    [
      "console table grid",
      "const rows=Array.from({length:50}).map(()=>({a:1})); const cols=Array.from({length:50}).map((_,i)=>String(i)); console.table(rows,cols); return 1",
    ],
    [
      "console table repeated content",
      'console.table([{a:"x".repeat(3000)}], Array.from({length:40}).map(()=>"a")); return 1',
    ],
    ["sticky exhaustion", 'for (let i = 0; i < 10000; i++) { try { "x".repeat(100000) } catch (e) {} }; return 1'],
  ])("rejects %s before unbounded native allocation", async (_name, code) => {
    const result = await run(code)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ResourceLimitExceeded")
  })

  test("counts fuel independently of the allocation budget", async () => {
    const result = await run("let count = 0; while (true) count++", { maxOperations: 200 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ResourceLimitExceeded")
  })

  test("keeps ordinary aggregates and bounded string processing available", async () => {
    expect(
      await run("const rows = [{ count: 4 }, { count: 8 }]; return rows.reduce((sum, row) => sum + row.count, 0)"),
    ).toEqual({
      ok: true,
      value: 12,
      toolCalls: [],
    })
    expect(await run('return "a,b,c".split(",").map(s => s.toUpperCase()).join(" ")')).toEqual({
      ok: true,
      value: "A B C",
      toolCalls: [],
    })
  })

  test("leaves existing unlimited execution behavior unchanged when limits are omitted", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({ code: "return Array.from({ length: 3000 }).length", tools: {} }),
    )
    expect(result).toEqual({ ok: true, value: 3000, toolCalls: [] })
  })
})
