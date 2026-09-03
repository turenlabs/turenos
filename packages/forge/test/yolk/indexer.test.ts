import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, unlink, utimes } from "node:fs/promises"
import os from "node:os"
import { IndexCache, buildImpactReport, buildIndex, compareIndexes, supportedLanguages } from "@turenlabs/core/yolk"

const fixtures = path.join(import.meta.dir, "fixtures")

async function compareSources(name: string, before: string, after: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-compare-"))
  const beforeRoot = path.join(root, "before")
  const afterRoot = path.join(root, "after")
  await Promise.all([mkdir(beforeRoot), mkdir(afterRoot)])
  await Promise.all([Bun.write(path.join(beforeRoot, name), before), Bun.write(path.join(afterRoot, name), after)])
  return compareIndexes(await buildIndex(beforeRoot), await buildIndex(afterRoot))
}

test("top-ten fixture indexes every supported language", async () => {
  const index = await buildIndex(path.join(fixtures, "top10"))

  expect(index.stats.parseErrors).toBe(0)
  for (const support of supportedLanguages()) {
    expect(index.stats.filesByLanguage.get(support.language)).toBeGreaterThan(0)
    expect(index.stats.symbolsByLanguage.get(support.language)).toBeGreaterThan(0)
  }
})

test("polyglot expressions converge and imported calls resolve", async () => {
  const index = await buildIndex(path.join(fixtures, "top10"))
  const target = index.functions.get("auth.IsInternal")

  expect(target?.confidence).toBe("pure-expression")
  expect(index.equivalents("auth.IsInternal")).toHaveLength(7)
  expect(index.functions.get("typescript.permissions.canAccess")?.calls).toEqual(["typescript.auth.isInternal"])
  expect(index.impact("shell.auth.is_internal")).toEqual([{ symbol: "shell.auth.can_access", distance: 1 }])
})

test("impact report and semantic comparison preserve prototype behavior", async () => {
  const before = await buildIndex(path.join(fixtures, "before"))
  const after = await buildIndex(path.join(fixtures, "after"))
  const impact = buildImpactReport(before, "auth.IsInternal")
  const report = compareIndexes(before, after)

  expect(impact.target).toBe("auth.IsInternal")
  expect([...impact.direct_callers, ...impact.transitive_callers]).toHaveLength(4)
  expect(impact.agent).toMatchObject({
    risk: "high",
    confidence: "high",
    target: "auth.IsInternal",
    indexHealth: { complete: true, filesSkipped: 0 },
  })
  expect(impact.agent.directCallers.every((caller) => caller.path && caller.line > 0)).toBe(true)
  expect(impact.agent.recommendedActions.length).toBeGreaterThan(0)
  expect(report.source_edits).toBe(2)
  expect(report.semantic_changes).toBe(1)
  expect(report.semantic_preserving_refactors).toBe(1)
  expect(report.changes.find((change) => change.symbol === "demo.Auth.isInternal")).toMatchObject({
    kind: "semantic-change",
    diverged_equivalents: expect.any(Array),
  })
  expect(report.changes.find((change) => change.symbol === "legacy.LegacyIsInternal")?.kind).toBe(
    "semantic-preserving-refactor",
  )
})

test("signature-only contract changes are semantic-unknown, not preserving refactors", async () => {
  const report = await compareSources(
    "value.ts",
    "export function value(): number { return 1 }\n",
    "export async function value(): Promise<number> { return 1 }\n",
  )
  expect(report.source_edits).toBe(1)
  expect(report.semantic_preserving_refactors).toBe(0)
  expect(report.semantic_unknown).toBe(1)
  expect(report.changes[0]?.kind).toBe("semantic-unknown")
})

test("multiline declaration modifiers are included in signature classification", async () => {
  const report = await compareSources(
    "Value.java",
    "class Value {\n  public\n  int get() { return 1; }\n}\n",
    "class Value {\n  private\n  int get() { return 1; }\n}\n",
  )
  expect(report.source_edits).toBe(1)
  expect(report.semantic_unknown).toBe(1)
})

test("multiline Python decorators are included in signature classification", async () => {
  const report = await compareSources(
    "handler.py",
    '@route(\n    methods=["GET"],\n)\ndef handler():\n    return True\n',
    '@route(\n    methods=["POST"],\n)\ndef handler():\n    return True\n',
  )
  expect(report.source_edits).toBe(1)
  expect(report.semantic_unknown).toBe(1)
})

test("untyped JavaScript boolean coercion is not treated as equivalent", async () => {
  const report = await compareSources(
    "value.js",
    "export function value(x) { return x === false }\n",
    "export function value(x) { return !x }\n",
  )
  expect(report.semantic_preserving_refactors).toBe(0)
  expect(report.semantic_changes).toBe(1)
})

test("indexing enforces repository limits and cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-limits-"))
  await Promise.all([
    Bun.write(path.join(root, "a.ts"), "export function a() { return true }\n"),
    Bun.write(path.join(root, "b.ts"), "export function b() { return true }\n"),
    Bun.write(path.join(root, "ignored.bin"), new Uint8Array(9 * 1024 * 1024)),
  ])

  const limited = await buildIndex(root, { maxFiles: 2, maxSourceBytes: 1024, maxFunctions: 1 })
  expect(limited.diagnostics.some((item) => item.kind === "repository-limit")).toBe(true)
  expect(limited.functions.size).toBeLessThanOrEqual(1)

  const nodeLimited = await buildIndex(root, { maxNodes: 1 })
  expect(nodeLimited.stats.eNodes).toBeLessThanOrEqual(1)
  expect(nodeLimited.diagnostics.some((item) => item.message.includes("e-graph node limit"))).toBe(true)

  const controller = new AbortController()
  controller.abort()
  await expect(buildIndex(root, { signal: controller.signal })).rejects.toBeDefined()
})

test("early managed or oversized sources do not prevent later project files from indexing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-admission-"))
  const managed = [path.join(root, ".forge"), path.join(root, ".worktrees"), path.join(root, "aaa/src")]
  const source = path.join(root, "packages/core/src")
  await Promise.all([...managed, source].map((directory) => mkdir(directory, { recursive: true })))
  await Promise.all([
    Bun.write(path.join(managed[0]!, "noise.ts"), "export function forgeNoise() { return true }\n".repeat(20)),
    Bun.write(path.join(managed[1]!, "noise.ts"), "export function worktreeNoise() { return true }\n".repeat(20)),
    Bun.write(path.join(managed[2]!, "large.ts"), "export function earlyNoise() { return true }\n".repeat(20)),
    Bun.write(path.join(source, "probe.ts"), "export function lateProbe() { return true }\n"),
  ])

  const index = await buildIndex(root, { maxSourceBytes: 128 })
  expect([...index.functions.keys()].some((symbol) => symbol.endsWith(".lateProbe"))).toBe(true)
  expect([...index.functions.keys()].some((symbol) => symbol.includes("Noise"))).toBe(false)

  const entryRoot = await mkdtemp(path.join(os.tmpdir(), "yolk-entries-"))
  await Promise.all(
    [".forge", ".worktrees", "src"].map((directory) => mkdir(path.join(entryRoot, directory), { recursive: true })),
  )
  await Bun.write(path.join(entryRoot, "src/probe.ts"), "export function entryProbe() { return true }\n")
  const entryLimited = await buildIndex(entryRoot, { maxFiles: 2 })
  expect([...entryLimited.functions.keys()].some((symbol) => symbol.endsWith(".entryProbe"))).toBe(true)

  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "yolk-binary-"))
  await Bun.write(
    path.join(binaryRoot, "self-extracting"),
    Buffer.concat([Buffer.from("#!/bin/sh\necho extracting\n"), Buffer.from([0]), Buffer.alloc(1024, 1)]),
  )
  const binary = await buildIndex(binaryRoot)
  expect(binary.functions.size).toBe(0)
  expect(binary.stats.filesSkipped).toBe(1)
})

test("incremental cache reparses changed files and reuses unchanged units", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-cache-"))
  const first = path.join(root, "first.ts")
  const second = path.join(root, "second.ts")
  await Promise.all([
    Bun.write(first, "export function firstValue() { return true }\n"),
    Bun.write(second, "export function secondValue() { return true }\n"),
  ])
  const cache = new IndexCache()
  const initial = await buildIndex(root, { cache })
  expect(initial.stats.cacheHits).toBe(0)

  const unchanged = await buildIndex(root, { cache })
  expect(unchanged.stats.cacheHits).toBe(2)

  await Bun.write(first, "export function changedValue() { return false }\n")
  const changed = await buildIndex(root, { cache })
  expect(changed.stats.cacheHits).toBe(1)
  expect([...changed.functions.keys()].some((symbol) => symbol.endsWith(".changedValue"))).toBe(true)
  expect([...changed.functions.keys()].some((symbol) => symbol.endsWith(".firstValue"))).toBe(false)

  await unlink(second)
  const deleted = await buildIndex(root, { cache })
  expect([...deleted.functions.keys()].some((symbol) => symbol.endsWith(".secondValue"))).toBe(false)
})

test("same-size rewrites cannot reuse stale cached symbols", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-cache-metadata-"))
  const file = path.join(root, "value.ts")
  await Bun.write(file, "export function beforeName() { return true }\n")
  const metadata = await Bun.file(file).stat()
  const cache = new IndexCache()
  await buildIndex(root, { cache })

  await Bun.write(file, "export function after_Name() { return true }\n")
  await utimes(file, metadata.atime, metadata.mtime)
  const changed = await buildIndex(root, { cache })
  expect([...changed.functions.keys()]).toContain("value.after_Name")
  expect([...changed.functions.keys()]).not.toContain("value.beforeName")
})

test("unsupported source languages make index health partial", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-unsupported-"))
  await Promise.all([
    Bun.write(path.join(root, "value.ts"), "export function sharedValue() { return true }\n"),
    Bun.write(path.join(root, "caller.rb"), "def caller\n  sharedValue\nend\n"),
  ])
  const impact = buildImpactReport(await buildIndex(root), "value.sharedValue")
  expect(impact.agent.confidence).toBe("partial")
  expect(impact.agent.indexHealth.complete).toBe(false)
  expect(impact.agent.indexHealth.diagnostics.join("\n")).toContain("unsupported-language")
})

test("comparison confidence includes baseline index health", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-baseline-health-"))
  const beforeRoot = path.join(root, "before")
  const afterRoot = path.join(root, "after")
  await Promise.all([mkdir(beforeRoot), mkdir(afterRoot)])
  await Promise.all([
    Bun.write(path.join(beforeRoot, "value.ts"), "export function value() { return true }\n"),
    Bun.write(path.join(beforeRoot, "caller.rb"), "def caller\n  value\nend\n"),
    Bun.write(path.join(afterRoot, "value.ts"), "export function value() { return false }\n"),
  ])
  const report = compareIndexes(await buildIndex(beforeRoot), await buildIndex(afterRoot))
  expect(report.agent.confidence).toBe("partial")
  expect(report.agent.indexHealth.diagnostics.join("\n")).toContain("before: unsupported-language")
})

test("validate-prefixed symbols are high-risk inspection targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-validation-risk-"))
  await Bun.write(path.join(root, "request.ts"), "export function validateRequest() { return true }\n")
  const impact = buildImpactReport(await buildIndex(root), "request.validateRequest")
  expect(impact.agent.risk).toBe("high")
  expect(impact.agent.recommendedActions.join("\n")).toContain("security")
})

test("removing a sensitive symbol produces high-risk recommendations", async () => {
  const report = await compareSources(
    "auth.ts",
    "export function authorizeUser() { return true }\n",
    "export function replacement() { return true }\n",
  )
  expect(report.removed_symbols).toContain("auth.authorizeUser")
  expect(report.agent.risk).toBe("high")
  expect(report.agent.recommendedActions.join("\n")).toContain("security")
})

test("recursive caller cycles never report the target as its own impact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-cycle-"))
  await Bun.write(
    path.join(root, "cycle.ts"),
    "export function first() { return second() }\nexport function second() { return first() }\n",
  )
  const index = await buildIndex(root)
  expect(index.impact("cycle.first")).toEqual([{ symbol: "cycle.second", distance: 1 }])
})

test("removed symbols retain caller evidence", async () => {
  const report = await compareSources(
    "shared.ts",
    "export function shared() { return true }\nexport function caller() { return shared() }\n",
    "export function caller() { return true }\n",
  )
  expect(report.removed_symbol_impacts).toEqual([
    { symbol: "shared.shared", callers: [{ symbol: "shared.caller", distance: 1 }], truncated: false },
  ])
  expect(report.agent.recommendedActions).toContain("Inspect callers of removed symbols before completing the change")
})

test("uniquely named project calls resolve across import aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-unique-call-"))
  await mkdir(path.join(root, "lib"))
  await Promise.all([
    Bun.write(path.join(root, "lib/runtime.ts"), "export function createRuntime() { return true }\n"),
    Bun.write(
      path.join(root, "consumer.ts"),
      'import { createRuntime } from "@project/runtime"\nexport function useRuntime() { return createRuntime() }\n',
    ),
  ])
  const index = await buildIndex(root)
  expect(index.impact("lib.runtime.createRuntime")).toEqual([{ symbol: "consumer.useRuntime", distance: 1 }])
})

test("exported zero-caller symbols retain public contract risk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-public-"))
  await Bun.write(path.join(root, "api.ts"), "export function publicApi() { return true }\n")
  const impact = buildImpactReport(await buildIndex(root), "api.publicApi")

  expect(impact.visibility).toBe("public")
  expect(impact.agent.risk).toBe("medium")
  expect(impact.agent.riskReasons).toContain("target is externally visible")
  expect(impact.agent.recommendedActions).toContain("Run contract or consumer tests for this public symbol")

  const cache = new IndexCache()
  await buildIndex(root, { cache })
  expect(buildImpactReport(await buildIndex(root, { cache }), "api.publicApi").visibility).toBe("public")
})

test("large symbol removals report collection truncation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yolk-truncated-removal-"))
  const beforeRoot = path.join(root, "before")
  const afterRoot = path.join(root, "after")
  await Promise.all([mkdir(beforeRoot), mkdir(afterRoot)])
  await Bun.write(
    path.join(beforeRoot, "api.ts"),
    Array.from({ length: 201 }, (_, index) => `export function value${index}() { return ${index} }`).join("\n"),
  )
  await Bun.write(path.join(afterRoot, "api.ts"), "export function replacement() { return true }\n")
  const report = compareIndexes(await buildIndex(beforeRoot), await buildIndex(afterRoot))

  expect(report.removed_symbols).toHaveLength(200)
  expect(report.removed_symbols_total).toBe(201)
  expect(report.removed_symbols_truncated).toBe(true)
  expect(report.agent.recommendedActions.join("\n")).toContain("added or removed symbol evidence is truncated")
})
