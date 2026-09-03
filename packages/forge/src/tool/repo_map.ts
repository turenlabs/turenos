import path from "path"
import { createHash } from "crypto"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Global } from "@turenlabs/core/global"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { Git } from "@/git"
import { containsPath } from "../project/instance-context"
import DESCRIPTION from "./repo_map.txt"
import * as Tool from "./tool"

// ---------------------------------------------------------------------------
// Tuning constants. The output is deliberately bounded: an agent should be able
// to read the whole map in one glance, so we cap the rendered text by *chars*
// (~4 chars/token, so ~8000 chars ≈ ~2000 tokens — an approximation, not exact
// token accounting) and cap the amount of filesystem work on the cold path.
// ---------------------------------------------------------------------------
const CHAR_CAP = 8000
const MAX_FILES = 20_000 // hard ceiling on files scanned; note truncation past this
const MAX_MATCHES = 20_000 // ceiling per ripgrep content pass
const TOP_FILES = 20 // ranked files that get symbol detail
const SYMBOLS_PER_FILE = 6
const SYMBOL_CANDIDATES_PER_FILE = 16
const SIZE_STAT_CANDIDATES = 48 // only stat this many top candidates for size sanity
const LARGE_FILE_BYTES = 150 * 1024
const CACHE_VERSION = "1"
const MEMO_CAP = 32 // per-directory in-session cached maps (keyed by repo state + scope + focus)

// Single-pass, multi-language "top-level declaration" regex. Rust-regex syntax
// (ripgrep): no lookaround/backrefs. `[[:space:]]` avoids backslash-escaping
// noise in the JS string. Intentionally broad — it feeds both export-density
// scoring and the symbol lines we render, so over-matching is cheap and
// under-matching is what actually hurts.
export const SYMBOL_REGEX = String.raw`^[[:space:]]*(export[[:space:]]+(default[[:space:]]+)?(async[[:space:]]+)?(function|class|const|let|var|type|interface|enum|namespace|abstract[[:space:]]+class)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*|export[[:space:]]*(default|\{|\*)|module\.exports|exports\.[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=|(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|pub[[:space:]]+(struct|enum|trait|mod|const|type)[[:space:]]+[A-Za-z_]|impl[[:space:]]+[A-Za-z_]|func[[:space:]]+(\([^)]*\)[[:space:]]*)?[A-Za-z_][A-Za-z0-9_]*|type[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+(struct|interface)|(async[[:space:]]+)?def[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|class[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|(public|protected)[[:space:]]+(static[[:space:]]+)?(final[[:space:]]+)?(abstract[[:space:]]+)?(class|interface|enum))`

// Lines that plausibly import/require/use another module. We only need the
// referenced module names to compute import in-degree.
export const IMPORT_REGEX = String.raw`(^[[:space:]]*import[[:space:]]|^[[:space:]]*from[[:space:]]|require[[:space:]]*\(|^[[:space:]]*use[[:space:]]+|^[[:space:]]*#include[[:space:]])`

const VENDORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "gen",
  "generated",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".cache",
  ".turbo",
  "bin",
  "obj",
  "Pods",
  "DerivedData",
])

const WORKSPACE_DIRS = new Set(["packages", "apps", "crates", "libs", "services", "plugins", "modules", "components"])

const MANIFEST_FILES = new Set([
  "package.json",
  "go.mod",
  "cargo.toml",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "composer.json",
])

const ENTRY_BASENAMES = new Set([
  "index",
  "main",
  "app",
  "cli",
  "mod",
  "lib",
  "server",
  "entry",
  "bootstrap",
  "program",
  "__main__",
  "__init__",
])

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\//i
const TEST_FILE_RE = /\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|\.stories\.[a-z0-9]+$/i

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description:
      "Optional subdirectory (relative to the workspace, or absolute inside it) to scope the map to. Omit to map the whole workspace.",
  }),
  focus: Schema.optional(Schema.String).annotate({
    description: "Optional term (e.g. a feature or subsystem name) to bias file ranking toward files that mention it.",
  }),
})

type Metadata = {
  files: number
  scanned: number
  truncated: boolean
  fileCapReached: boolean
  cached: boolean
  focus?: string
  root: string
}

type CacheBlob = {
  v: string
  key: string
  output: string
  metadata: Metadata
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export function isGeneratedPath(rel: string): boolean {
  const p = rel.replaceAll("\\", "/").toLowerCase()
  if (/(^|\/)(dist|build|out|gen|generated|target|\.next|coverage)\//.test(p)) return true
  if (/\.min\.(js|css|mjs|cjs)$/.test(p)) return true
  if (/\.(map|lock)$/.test(p)) return true
  if (
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|bun\.lockb|cargo\.lock|poetry\.lock|composer\.lock|gemfile\.lock)$/.test(
      p,
    )
  )
    return true
  if (/\.(pb\.go|_pb2\.py|_pb2_grpc\.py|g\.dart|freezed\.dart|generated\.[a-z]+)$/.test(p)) return true
  if (/\.d\.ts$/.test(p)) return true
  if (/(^|\/)__snapshots__\//.test(p)) return true
  return false
}

/** True when any path segment is a vendored/collapsed directory. Such files are
 * still counted in the structure skeleton but excluded from the ranked key
 * files list — collapsed means collapsed everywhere. */
export function isVendoredFile(rel: string): boolean {
  return rel
    .replaceAll("\\", "/")
    .split("/")
    .slice(0, -1)
    .some((seg) => VENDORED_DIRS.has(seg))
}

function basenameNoExt(rel: string): string {
  const base = rel.replaceAll("\\", "/").split("/").pop() ?? rel
  const dot = base.indexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}

/** The key other files would use to import this file (basename, or the parent
 * directory name for index/mod/__init__ style barrel files). */
export function importKeyForFile(rel: string): string {
  const segments = rel.replaceAll("\\", "/").split("/")
  const base = basenameNoExt(rel).toLowerCase()
  if ((base === "index" || base === "mod" || base === "__init__" || base === "main") && segments.length >= 2) {
    return segments[segments.length - 2]!.toLowerCase()
  }
  return base
}

/** Extract the module names referenced by a single import-ish line. */
export function parseImportKeys(line: string): string[] {
  const keys: string[] = []
  const push = (raw: string | undefined) => {
    if (!raw) return
    const trimmed = raw.trim()
    if (!trimmed || trimmed === "." || trimmed === "..") return
    const seg = trimmed.replaceAll("\\", "/").split("/").filter(Boolean).pop()
    if (!seg) return
    const key = basenameNoExt(seg).toLowerCase()
    if (key && key !== "." && key !== "..") keys.push(key)
  }

  // Quoted specifiers (JS/TS import & require, Go import "path", C #include "x").
  const quoted = line.match(/["'`]([^"'`]+)["'`]/g)
  if (quoted) for (const q of quoted) push(q.slice(1, -1))

  // Python: `import a.b.c` / `from a.b import x`
  const py = line.match(/^\s*(?:from|import)\s+([\w.]+)/)
  if (py?.[1]) {
    const parts = py[1].split(".").filter(Boolean)
    if (parts.length) keys.push(parts[parts.length - 1]!.toLowerCase())
  }

  // Rust: `use crate::a::b::C;`
  const rust = line.match(/\buse\s+([\w:]+)/)
  if (rust?.[1]) {
    const parts = rust[1].split("::").filter((s) => /^[a-z_]/.test(s))
    for (const p of parts.slice(-2)) keys.push(p.toLowerCase())
  }

  return keys
}

function entryPointBonus(rel: string): number {
  const p = rel.replaceAll("\\", "/")
  const base = p.split("/").pop() ?? p
  const lower = base.toLowerCase()
  const depth = p.split("/").length - 1
  let bonus = 0
  if (MANIFEST_FILES.has(lower)) bonus += 24
  const stem = basenameNoExt(rel).toLowerCase()
  if (ENTRY_BASENAMES.has(stem)) {
    bonus += 26
    if (depth <= 2) bonus += 10
  }
  if (depth === 0) bonus += 6 // root-level files are orientation-relevant
  return bonus
}

type RankInput = {
  files: string[]
  symbolCount: Map<string, number>
  importCounts: Map<string, number>
  focusCounts: Map<string, number>
  sizes: Map<string, number>
  entryTargets: Set<string>
  hasFocus: boolean
}

export type Ranked = { rel: string; score: number }

export function rankFiles(input: RankInput): Ranked[] {
  const ranked = input.files.map((rel) => {
    const key = importKeyForFile(rel)
    const symbols = input.symbolCount.get(rel) ?? 0
    const inDegree = input.importCounts.get(key) ?? 0
    const focus = input.focusCounts.get(rel) ?? 0
    const depth = rel.replaceAll("\\", "/").split("/").length - 1

    let score = 0
    score += entryPointBonus(rel)
    if (input.entryTargets.has(rel)) score += 35
    score += Math.min(symbols, 30) * 1.5
    score += Math.min(inDegree, 40) * 2
    // Focus is a strong, deliberate bias: a couple of mentions should pull a
    // file above generic entry points so the map suits the task at hand.
    if (input.hasFocus) score += Math.min(focus, 25) * 18
    score -= depth

    let mult = 1
    if (isGeneratedPath(rel)) mult *= 0.15
    if (TEST_RE.test(rel) || TEST_FILE_RE.test(rel)) mult *= 0.5
    const size = input.sizes.get(rel)
    if (size !== undefined && size > LARGE_FILE_BYTES) mult *= 0.3

    return { rel, score: score * mult }
  })

  ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  return ranked
}

type DirNode = { count: number; children: Map<string, DirNode> }

function makeNode(): DirNode {
  return { count: 0, children: new Map() }
}

function buildTree(files: string[]): DirNode {
  const root = makeNode()
  for (const file of files) {
    const parts = file.replaceAll("\\", "/").split("/")
    let node = root
    node.count++
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      let child = node.children.get(seg)
      if (!child) {
        child = makeNode()
        node.children.set(seg, child)
      }
      child.count++
      node = child
    }
  }
  return root
}

/** Render the directory skeleton, expanding an extra level under workspace
 * dirs (packages/ etc.) so monorepo package roots surface. */
export function renderStructure(files: string[], budget: number): string {
  const root = buildTree(files)
  const lines: string[] = []
  const topDirs = [...root.children.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  const rootFiles = root.count - topDirs.reduce((sum, [, node]) => sum + node.count, 0)

  const emit = (line: string) => {
    if (lines.join("\n").length + line.length + 1 <= budget) lines.push(line)
  }

  for (const [name, node] of topDirs) {
    const isWorkspace = WORKSPACE_DIRS.has(name)
    const isVendored = VENDORED_DIRS.has(name)
    if (isVendored) {
      emit(`${name}/ (${node.count}, collapsed)`)
      continue
    }
    emit(`${name}/ (${node.count})${isWorkspace ? "  [workspace]" : ""}`)
    // Expand children: workspace roots get one deeper level so package roots show.
    const subs = [...node.children.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    const showSubs = isWorkspace ? subs.length : Math.min(subs.length, 4)
    for (const [subName, subNode] of subs.slice(0, showSubs)) {
      if (VENDORED_DIRS.has(subName)) {
        emit(`  ${subName}/ (${subNode.count}, collapsed)`)
        continue
      }
      emit(`  ${subName}/ (${subNode.count})`)
    }
    if (subs.length > showSubs) emit(`  … +${subs.length - showSubs} more dirs`)
  }
  if (rootFiles > 0) emit(`(root: ${rootFiles} file${rootFiles === 1 ? "" : "s"})`)

  return lines.join("\n")
}

function cleanSymbol(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 90 ? collapsed.slice(0, 87) + "…" : collapsed
}

// ---------------------------------------------------------------------------
// Cold-path computation
// ---------------------------------------------------------------------------

type ComputeInput = {
  rootRel: string
  files: { rel: string }[]
  fileCapReached: boolean
  symbols: { rel: string; line: number; text: string }[]
  imports: { text: string }[]
  focusMatches: { rel: string }[]
  sizes: Map<string, number>
  entryTargets: Set<string>
  focus?: string
  gitLabel: string
}

export function computeMap(input: ComputeInput): { output: string; metadata: Metadata } {
  const files = input.files.map((f) => f.rel)
  const symbolCount = new Map<string, number>()
  const symbolsByFile = new Map<string, { line: number; text: string; indent: number }[]>()
  for (const s of input.symbols) {
    symbolCount.set(s.rel, (symbolCount.get(s.rel) ?? 0) + 1)
    const list = symbolsByFile.get(s.rel) ?? []
    if (list.length < SYMBOL_CANDIDATES_PER_FILE) {
      const indent = s.text.length - s.text.replace(/^[\t ]+/, "").length
      list.push({ line: s.line, text: s.text, indent })
      symbolsByFile.set(s.rel, list)
    }
  }

  const importCounts = new Map<string, number>()
  for (const imp of input.imports) {
    for (const key of parseImportKeys(imp.text)) {
      importCounts.set(key, (importCounts.get(key) ?? 0) + 1)
    }
  }

  const focusCounts = new Map<string, number>()
  for (const m of input.focusMatches) focusCounts.set(m.rel, (focusCounts.get(m.rel) ?? 0) + 1)

  // Structure counts every file, but vendored/collapsed files never rank.
  const ranked = rankFiles({
    files: files.filter((f) => !isVendoredFile(f)),
    symbolCount,
    importCounts,
    focusCounts,
    sizes: input.sizes,
    entryTargets: input.entryTargets,
    hasFocus: Boolean(input.focus),
  })

  // ---- render, respecting the char cap ----
  const header: string[] = []
  header.push(`# Repo map: ${input.rootRel || "."}`)
  const scanNote = input.fileCapReached
    ? `${files.length} files (scan capped at ${MAX_FILES}, map is partial)`
    : `${files.length} files`
  header.push(`${scanNote} · ${input.gitLabel}${input.focus ? ` · focus: ${input.focus}` : ""}`)

  const structureBudget = 1600
  const structure = renderStructure(files, structureBudget)

  const parts: string[] = []
  parts.push(header.join("\n"))
  if (structure) parts.push(`## Structure\n${structure}`)

  const keyLines: string[] = ["## Key files"]
  let shownFiles = 0
  let truncated = input.fileCapReached
  const currentLength = () => parts.join("\n\n").length + "\n\n".length + keyLines.join("\n").length

  for (let i = 0; i < ranked.length && shownFiles < TOP_FILES; i++) {
    const { rel, score } = ranked[i]!
    if (score < 0 && shownFiles > 0) break

    const tags: string[] = []
    const sym = symbolCount.get(rel) ?? 0
    const inDeg = importCounts.get(importKeyForFile(rel)) ?? 0
    if (input.entryTargets.has(rel) || entryPointBonus(rel) >= 24) tags.push("entry")
    if (sym > 0) tags.push(`${sym} sym`)
    if (inDeg > 0) tags.push(`${inDeg}× imported`)
    const focusN = focusCounts.get(rel) ?? 0
    if (input.focus && focusN > 0) tags.push(`${focusN}× focus`)

    const block: string[] = []
    block.push(`${shownFiles + 1}. ${rel}${tags.length ? `  [${tags.join(", ")}]` : ""}`)

    const candidates = (symbolsByFile.get(rel) ?? [])
      .slice()
      .sort((a, b) => a.indent - b.indent || a.line - b.line)
      .slice(0, SYMBOLS_PER_FILE)
      .sort((a, b) => a.line - b.line)
    for (const c of candidates) block.push(`   - ${cleanSymbol(c.text)} (L${c.line})`)

    const candidateText = block.join("\n")
    // Stop before we blow the cap; leave room for the trailing note.
    if (currentLength() + candidateText.length + 120 > CHAR_CAP) {
      truncated = true
      break
    }
    keyLines.push(candidateText)
    shownFiles++
  }

  parts.push(keyLines.join("\n"))

  if (truncated) {
    parts.push(`(map truncated to ~${Math.round(CHAR_CAP / 1000)}KB; refine with \`path\` or \`focus\`)`)
  }

  let output = parts.join("\n\n")
  if (output.length > CHAR_CAP) output = output.slice(0, CHAR_CAP - 1).trimEnd() + "…"

  return {
    output,
    metadata: {
      files: files.length,
      scanned: files.length,
      truncated,
      fileCapReached: input.fileCapReached,
      cached: false,
      focus: input.focus,
      root: input.rootRel,
    },
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const RepoMapTool = Tool.define(
  "repo_map",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const git = yield* Git.Service
    const global = yield* Global.Service

    // Per-directory, per-session memo. Holds a small LRU-ish map keyed by the
    // full cache key (repo state + scope + focus), so a HEAD change naturally
    // misses (the key changes) and forces a recompute.
    const memo = yield* InstanceState.make<Map<string, CacheBlob>>(() => Effect.succeed(new Map()))

    const cacheDir = path.join(global.cache, "repo-map")

    const diskPath = (directory: string, scopeRel: string, focus: string | undefined) => {
      const hash = createHash("sha256") // batou:ignore crypto -- non-security cache key, sha256 over local paths only
        .update(`${directory}\0${scopeRel}\0${focus ?? ""}`)
        .digest("hex")
        .slice(0, 32)
      return path.join(cacheDir, `${hash}.json`)
    }

    const stateSignal = Effect.fn("RepoMap.stateSignal")(function* (gitRoot: string, scanRoot: string) {
      const hasHead = yield* git.hasHead(gitRoot).pipe(Effect.orElseSucceed(() => false))
      if (hasHead) {
        const res = yield* git.run(["rev-parse", "HEAD"], { cwd: gitRoot }).pipe(
          Effect.map((r) => (r.exitCode === 0 ? r.text().trim() : undefined)),
          Effect.orElseSucceed(() => undefined),
        )
        if (res) return { signal: `git:${res}`, label: `git ${res.slice(0, 8)}` }
      }
      // Non-git fallback: cheap newest-mtime heuristic over top-level entries
      // (may serve a slightly stale map for deep edits — the in-session memo and
      // the git path are the primary freshness mechanisms).
      const entries = yield* fs.readDirectoryEntries(scanRoot).pipe(Effect.orElseSucceed(() => []))
      let newest = 0
      for (const entry of entries) {
        const info = yield* fs.stat(path.join(scanRoot, entry.name)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info ? Option.getOrUndefined(info.mtime) : undefined
        if (mtime) newest = Math.max(newest, mtime.getTime())
      }
      return { signal: `mtime:${newest}:${entries.length}`, label: "non-git (mtime heuristic)" }
    })

    const collectEntryTargets = Effect.fn("RepoMap.entryTargets")(function* (scanRoot: string, files: string[]) {
      const targets = new Set<string>()
      const manifests = files
        .filter((f) => path.basename(f).toLowerCase() === "package.json")
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .slice(0, 10)
      for (const manifest of manifests) {
        const json = yield* fs
          .readJson(path.join(scanRoot, manifest))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!json || typeof json !== "object") continue
        const dir = path.dirname(manifest)
        const rel = (target: string) => {
          const joined = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, target.replace(/^\.\//, "")))
          return joined.startsWith("/") ? joined.slice(1) : joined
        }
        const record = json as Record<string, unknown>
        for (const field of ["main", "module"]) {
          const value = record[field]
          if (typeof value === "string") targets.add(rel(value))
        }
        const bin = record["bin"]
        if (typeof bin === "string") targets.add(rel(bin))
        else if (bin && typeof bin === "object")
          for (const value of Object.values(bin)) if (typeof value === "string") targets.add(rel(value))
      }
      return targets
    })

    const compute = Effect.fn("RepoMap.compute")(function* (input: {
      scanRoot: string
      rootRel: string
      focus?: string
      gitLabel: string
    }) {
      const found = yield* ripgrep
        .find({ cwd: input.scanRoot, pattern: "*", limit: MAX_FILES })
        .pipe(Effect.orElseSucceed(() => []))
      const files = found.map((e) => ({ rel: e.path as string }))
      const fileCapReached = files.length >= MAX_FILES

      const [symbolRaw, importRaw, focusRaw] = yield* Effect.all(
        [
          ripgrep
            .grep({ cwd: input.scanRoot, pattern: SYMBOL_REGEX, limit: MAX_MATCHES })
            .pipe(Effect.orElseSucceed(() => [])),
          ripgrep
            .grep({ cwd: input.scanRoot, pattern: IMPORT_REGEX, limit: MAX_MATCHES })
            .pipe(Effect.orElseSucceed(() => [])),
          input.focus
            ? ripgrep
                .grep({ cwd: input.scanRoot, pattern: `(?i)${escapeRegex(input.focus)}`, limit: MAX_MATCHES })
                .pipe(Effect.orElseSucceed(() => []))
            : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      )

      const symbols = symbolRaw.map((m) => ({ rel: m.entry.path as string, line: m.line, text: m.text }))
      const imports = importRaw.map((m) => ({ text: m.text }))
      const focusMatches = focusRaw.map((m) => ({ rel: m.entry.path as string }))

      const entryTargets = yield* collectEntryTargets(
        input.scanRoot,
        files.map((f) => f.rel),
      )

      // Size sanity: stat only the top preliminary candidates (cheap) so giant
      // generated/data files get down-ranked without statting the whole tree.
      const prelim = rankFiles({
        files: files.map((f) => f.rel).filter((rel) => !isVendoredFile(rel)),
        symbolCount: countBy(symbols.map((s) => s.rel)),
        importCounts: tallyImports(imports),
        focusCounts: countBy(focusMatches.map((f) => f.rel)),
        sizes: new Map(),
        entryTargets,
        hasFocus: Boolean(input.focus),
      })
      const sizes = new Map<string, number>()
      for (const { rel } of prelim.slice(0, SIZE_STAT_CANDIDATES)) {
        const info = yield* fs.stat(path.join(input.scanRoot, rel)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (info) sizes.set(rel, Number(info.size))
      }

      return computeMap({
        rootRel: input.rootRel,
        files,
        fileCapReached,
        symbols,
        imports,
        focusMatches,
        sizes,
        entryTargets,
        focus: input.focus,
        gitLabel: input.gitLabel,
      })
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { path?: string; focus?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context

          // Resolve + validate scope strictly inside the workspace.
          const requested = params.path
            ? path.isAbsolute(params.path)
              ? params.path
              : path.resolve(ins.directory, params.path)
            : ins.directory
          const scanRoot = yield* fs.resolve(requested)
          if (!containsPath(scanRoot, ins)) {
            throw new Error(`repo_map path is outside the workspace: ${scanRoot}`)
          }
          const info = yield* fs.stat(scanRoot).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) throw new Error(`repo_map path does not exist: ${scanRoot}`)
          if (info.type !== "Directory") throw new Error(`repo_map path must be a directory: ${scanRoot}`)

          const rootRel = path.relative(ins.worktree === "/" ? ins.directory : ins.worktree, scanRoot)
          const scopeRel = path.relative(ins.directory, scanRoot) || "."
          const focus = params.focus?.trim() || undefined

          yield* ctx.ask({
            permission: "read",
            patterns: [rootRel || "."],
            always: ["*"],
            metadata: { path: scopeRel, focus },
          })

          const gitRoot = ins.worktree && ins.worktree !== "/" ? ins.worktree : ins.directory
          const { signal, label } = yield* stateSignal(gitRoot, scanRoot)
          const key = `${CACHE_VERSION}|${signal}|${scopeRel}|${focus ?? ""}|cap${MAX_FILES}`

          const title = rootRel || "."
          const memoMap = yield* InstanceState.get(memo)

          const hit = memoMap.get(key)
          if (hit) {
            return { title, metadata: { ...hit.metadata, cached: true }, output: hit.output }
          }

          // On-disk cache (survives across sessions for the same repo state).
          const file = diskPath(ins.directory, scopeRel, focus)
          const onDisk = yield* fs.readJson(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (isCacheBlob(onDisk) && onDisk.v === CACHE_VERSION && onDisk.key === key) {
            rememberInMemo(memoMap, key, onDisk)
            return { title, metadata: { ...onDisk.metadata, cached: true }, output: onDisk.output }
          }

          const computed = yield* compute({ scanRoot, rootRel, focus, gitLabel: label })
          const blob: CacheBlob = { v: CACHE_VERSION, key, output: computed.output, metadata: computed.metadata }
          rememberInMemo(memoMap, key, blob)
          yield* fs.ensureDir(cacheDir).pipe(Effect.andThen(fs.writeJson(file, blob)), Effect.ignore)

          return { title, metadata: computed.metadata, output: computed.output }
        }).pipe(Effect.orDie),
    }
  }),
)

function countBy(items: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1)
  return map
}

function tallyImports(imports: { text: string }[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const imp of imports) for (const key of parseImportKeys(imp.text)) map.set(key, (map.get(key) ?? 0) + 1)
  return map
}

function rememberInMemo(map: Map<string, CacheBlob>, key: string, blob: CacheBlob) {
  if (map.has(key)) map.delete(key)
  map.set(key, blob)
  while (map.size > MEMO_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function isCacheBlob(value: unknown): value is CacheBlob {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    "key" in value &&
    "output" in value &&
    "metadata" in value &&
    typeof (value as CacheBlob).output === "string"
  )
}
