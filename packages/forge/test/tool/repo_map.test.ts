import { PermissionV1 } from "@turenlabs/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Global } from "@turenlabs/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import {
  RepoMapTool,
  isGeneratedPath,
  parseImportKeys,
  importKeyForFile,
  rankFiles,
  computeMap,
} from "../../src/tool/repo_map"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

// Shared on-disk cache dir for the whole file. Disk-cache filenames hash the
// (unique per test) instance directory, so tests never collide even though they
// share this root.
const CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "repomap-cache-"))

const toolLayer = LayerNode.compile(
  LayerNode.group([
    CrossSpawnSpawner.node,
    FSUtil.node,
    Ripgrep.node,
    Truncate.node,
    Agent.node,
    Git.node,
    Global.node,
  ]),
  [[Global.node, Global.layerWith({ cache: CACHE_ROOT })]],
)

const it = testEffect(toolLayer)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} as unknown as Tool.Context

const write = (dir: string, rel: string, content: string) =>
  Effect.promise(() => Bun.write(path.join(dir, rel), content))

const gitCmd = (cwd: string, ...args: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(err.trim() || out.trim() || `git ${args.join(" ")} failed`)
    return out.trim()
  })

const repoMap = (params: { path?: string; focus?: string }, override?: Partial<Tool.Context>) =>
  Effect.gen(function* () {
    const info = yield* RepoMapTool
    const tool = yield* info.init()
    return yield* tool.execute(params, { ...ctx, ...override })
  })

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe("tool.repo_map helpers", () => {
  it.effect("isGeneratedPath flags vendored/generated/lock paths", () =>
    Effect.sync(() => {
      expect(isGeneratedPath("dist/bundle.js")).toBe(true)
      expect(isGeneratedPath("src/gen/api.ts")).toBe(true) // a gen/ segment anywhere counts as generated
      expect(isGeneratedPath("gen/api.ts")).toBe(true)
      expect(isGeneratedPath("app.min.js")).toBe(true)
      expect(isGeneratedPath("bun.lock")).toBe(true)
      expect(isGeneratedPath("types.d.ts")).toBe(true)
      expect(isGeneratedPath("src/session/session.ts")).toBe(false)
    }),
  )

  it.effect("parseImportKeys extracts module basenames across languages", () =>
    Effect.sync(() => {
      expect(parseImportKeys(`import { A } from "./foo/bar"`)).toContain("bar")
      expect(parseImportKeys(`const x = require("../util/helper")`)).toContain("helper")
      expect(parseImportKeys(`from app.services.auth import login`)).toContain("auth")
      expect(parseImportKeys(`use crate::session::manager;`)).toEqual(expect.arrayContaining(["session", "manager"]))
      expect(parseImportKeys(`  const local = 1`)).toEqual([])
    }),
  )

  it.effect("importKeyForFile uses parent dir for barrel files", () =>
    Effect.sync(() => {
      expect(importKeyForFile("src/session/index.ts")).toBe("session")
      expect(importKeyForFile("src/session/manager.ts")).toBe("manager")
      expect(importKeyForFile("pkg/mod.rs")).toBe("pkg")
    }),
  )

  it.effect("rankFiles ranks entry points and imported files above filler", () =>
    Effect.sync(() => {
      const files = ["src/index.ts", "src/widely-used.ts", "src/filler.ts"]
      const ranked = rankFiles({
        files,
        symbolCount: new Map([
          ["src/index.ts", 8],
          ["src/widely-used.ts", 4],
          ["src/filler.ts", 0],
        ]),
        importCounts: new Map([["widely-used", 30]]),
        focusCounts: new Map(),
        sizes: new Map(),
        entryTargets: new Set(),
        hasFocus: false,
      })
      expect(ranked[0]!.rel).not.toBe("src/filler.ts")
      expect(ranked.map((r) => r.rel).slice(0, 2)).toEqual(
        expect.arrayContaining(["src/index.ts", "src/widely-used.ts"]),
      )
      expect(ranked[2]!.rel).toBe("src/filler.ts")
    }),
  )

  it.effect("computeMap hard-caps output length and notes truncation", () =>
    Effect.sync(() => {
      // 40 files, each with 8 long exported symbols — far more than fits.
      const files = Array.from({ length: 40 }, (_, i) => ({ rel: `src/module_${i}.ts` }))
      const symbols = files.flatMap((f) =>
        Array.from({ length: 8 }, (_, j) => ({
          rel: f.rel,
          line: j + 1,
          text: `export function veryDescriptiveExportedSymbolNumber${j}InModule() { return ${j} }`,
        })),
      )
      const result = computeMap({
        rootRel: "",
        files,
        fileCapReached: false,
        symbols,
        imports: [],
        focusMatches: [],
        sizes: new Map(),
        entryTargets: new Set(),
        gitLabel: "git deadbeef",
      })
      expect(result.output.length).toBeLessThanOrEqual(8000)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("truncated")
    }),
  )
})

// ---------------------------------------------------------------------------
// Integration tests over synthetic fixture trees
// ---------------------------------------------------------------------------

describe("tool.repo_map integration", () => {
  it.instance(
    "ranks entry points and reports symbols/imports",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, "package.json", JSON.stringify({ name: "demo", main: "src/index.ts" }))
        yield* write(
          dir,
          "src/index.ts",
          `export function main() {}\nexport class App {}\nexport const VERSION = "1"\n`,
        )
        yield* write(dir, "src/util.ts", `export function helper() {}\n`)
        for (let i = 0; i < 5; i++) {
          yield* write(dir, `src/consumer${i}.ts`, `import { helper } from "./util"\nconst x = helper()\n`)
        }
        yield* write(dir, "src/empty.ts", `const nothing = 1\n`)

        const result = yield* repoMap({})
        expect(result.output).toContain("# Repo map")
        expect(result.output).toContain("## Structure")
        expect(result.output).toContain("## Key files")
        // index.ts is an entry point AND package.json main → ranks first.
        expect(result.output).toContain("src/index.ts")
        expect(result.output).toContain("export function main()")
        // util.ts is imported by 5 files → surfaces as widely imported.
        expect(result.output).toMatch(/util\.ts.*imported/)
        expect(result.metadata.cached).toBe(false)
        expect(result.metadata.files).toBeGreaterThan(0)
      }),
    { git: true },
  )

  it.instance(
    "honors .gitignore and collapses vendored directories",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, ".gitignore", "ignored/\n")
        yield* write(dir, "ignored/secret.ts", `export const secret = "nope"\n`)
        yield* write(dir, "src/app.ts", `export function app() {}\n`)
        for (let i = 0; i < 4; i++) yield* write(dir, `vendor/lib${i}.js`, `module.exports = {}\n`)

        const result = yield* repoMap({})
        expect(result.output).not.toContain("secret")
        expect(result.output).not.toContain("ignored/")
        // vendor is shown collapsed, its children are not listed.
        expect(result.output).toContain("vendor/ (4, collapsed)")
        expect(result.output).not.toContain("lib0.js")
      }),
    { git: true },
  )

  it.instance(
    "focus biases ranking toward matching files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, "src/index.ts", `export function main() {}\n`)
        yield* write(
          dir,
          "src/payment.ts",
          `export function chargePayment() {}\n// payment payment payment gateway\nexport const paymentProvider = 1\n`,
        )
        yield* write(dir, "src/rendering.ts", `export function render() {}\n`)

        const focused = yield* repoMap({ focus: "payment" })
        expect(focused.output).toContain("focus: payment")
        expect(focused.output).toMatch(/payment\.ts.*focus/)
        expect(focused.metadata.focus).toBe("payment")
        // payment.ts should be the top-ranked key file under focus.
        const firstKeyLine = focused.output.split("## Key files\n")[1]?.split("\n")[0] ?? ""
        expect(firstKeyLine).toContain("payment.ts")
      }),
    { git: true },
  )

  it.instance(
    "scopes to a subdirectory and surfaces monorepo package roots",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, "packages/app/index.ts", `export function app() {}\n`)
        yield* write(dir, "packages/core/index.ts", `export function core() {}\n`)
        yield* write(dir, "packages/core/deep/mod.ts", `export const deep = 1\n`)

        const full = yield* repoMap({})
        expect(full.output).toContain("packages/")
        expect(full.output).toContain("[workspace]")
        expect(full.output).toContain("app/")
        expect(full.output).toContain("core/")

        const scoped = yield* repoMap({ path: "packages/app" })
        expect(scoped.output).toContain("packages/app")
        expect(scoped.output).toContain("index.ts")
        expect(scoped.output).not.toContain("core")
      }),
    { git: true },
  )

  it.instance(
    "rejects paths outside the workspace",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(test.directory, "src/app.ts", `export const a = 1\n`)
        const exit = yield* repoMap({ path: "../../../../etc" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(err instanceof Error ? err.message : String(err)).toContain("outside the workspace")
        }
      }),
    { git: true },
  )

  it.instance(
    "caches within a session and invalidates when git HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, "src/index.ts", `export function main() {}\n`)
        yield* gitCmd(dir, "add", "-A")
        yield* gitCmd(dir, "commit", "-m", "first")

        const info = yield* RepoMapTool
        const tool = yield* info.init()

        const first = yield* tool.execute({}, ctx)
        expect(first.metadata.cached).toBe(false)

        // Warm: in-session memo hit — no recompute, and much faster.
        const t0 = performance.now()
        const second = yield* tool.execute({}, ctx)
        const warmMs = performance.now() - t0
        expect(second.metadata.cached).toBe(true)
        expect(second.output).toBe(first.output)
        expect(warmMs).toBeLessThan(200) // target is <50ms; generous bound for CI

        // A new commit moves HEAD → cache key changes → recompute.
        yield* write(dir, "src/added.ts", `export function added() {}\n`)
        yield* gitCmd(dir, "add", "-A")
        yield* gitCmd(dir, "commit", "-m", "second")

        const third = yield* tool.execute({}, ctx)
        expect(third.metadata.cached).toBe(false)
        expect(third.output).toContain("src/added.ts")
      }),
    { git: true },
  )

  it.instance(
    "reuses the on-disk cache across fresh tool instances at the same HEAD",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory
        yield* write(dir, "src/index.ts", `export function main() {}\n`)
        yield* gitCmd(dir, "add", "-A")
        yield* gitCmd(dir, "commit", "-m", "first")

        // First tool instance: cold, writes the disk blob.
        const first = yield* repoMap({})
        expect(first.metadata.cached).toBe(false)

        // A brand-new tool instance has an empty in-session memo, so a hit here
        // must have come from disk.
        const second = yield* repoMap({})
        expect(second.metadata.cached).toBe(true)
        expect(second.output).toBe(first.output)
      }),
    { git: true },
  )
})
