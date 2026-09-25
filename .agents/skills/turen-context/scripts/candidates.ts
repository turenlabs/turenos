#!/usr/bin/env bun
// Lists the evidence for placing AGENTS.md files: every code area (a folder with its own package.json scripts,
// Cargo.toml, go.mod, pyproject.toml or Makefile), whether it has its own AGENTS.md or inherits one, its recent churn,
// how many of those commits were fixes or reverts, its main languages, and its script count. Areas without their own
// AGENTS.md come first, most fix-heavy first. The numbers are leads; SKILL.md's placement bar decides. Read-only.
//
// usage: bun .agents/skills/turen-context/scripts/candidates.ts [--since "6 months ago"] [--all]

import path from "node:path"
import { readFileSync } from "node:fs"

const VENDORED = /(^|\/)(vendor|node_modules|dist|build|third[-_]party|fixtures?|__snapshots__)\//
// Checked-in, checksum-verified WASM build outputs; the root AGENTS.md already says not to edit them.
const GENERATED = /^packages\/[^/]+-wasm(\/|$)/
const ROOT = "AGENTS.md (root)"
const MANIFESTS = new Set(["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Makefile"])

const args = process.argv.slice(2)
const sinceIndex = args.indexOf("--since")
const since = sinceIndex === -1 ? "6 months ago" : (args[sinceIndex + 1] ?? "6 months ago")
const root = git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd()
const tracked = (git(root, "ls-files") ?? "").split("\n").filter((file) => file.length > 0 && !VENDORED.test(file))
const instructionFolders = new Set(
  tracked.filter((file) => path.posix.basename(file) === "AGENTS.md").map((file) => path.posix.dirname(file)),
)
const areas = [
  ...new Set(
    tracked
      .filter((file) => MANIFESTS.has(path.posix.basename(file)) && file.includes("/") && !GENERATED.test(file))
      .map((file) => path.posix.dirname(file)),
  ),
].toSorted((a, b) => b.length - a.length)
const owners = new Map(tracked.map((file) => [file, owner(file)]))
const history = commits().map((commit) => ({
  subject: commit.subject,
  areas: new Set(commit.files.map((file) => owners.get(file) ?? owner(file))),
}))

const rows = areas.map((area) => {
  const files = tracked.filter((file) => owners.get(file) === area)
  const touched = history.filter((commit) => commit.areas.has(area))
  const extensions = new Map<string, number>()
  files.forEach((file) => {
    const ext = path.posix.extname(file).slice(1)
    if (ext !== "") extensions.set(ext, (extensions.get(ext) ?? 0) + 1)
  })
  return {
    area,
    own: instructionFolders.has(area),
    nearest: nearestInstructions(area),
    commits: touched.length,
    fixes: touched.filter((commit) => /^(fix|revert)\b/i.test(commit.subject)).length,
    files: files.length,
    languages: [...extensions]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map((entry) => entry[0])
      .join(","),
    scripts: scriptCount(area),
  }
})

const shown = rows
  .filter((row) => args.includes("--all") || row.files >= 5)
  // Areas with no AGENTS.md of their own come first; among them, those covered only by the root file.
  .toSorted(
    (a, b) =>
      Number(a.own) - Number(b.own) ||
      Number(a.nearest !== ROOT) - Number(b.nearest !== ROOT) ||
      b.fixes - a.fixes ||
      b.commits - a.commits,
  )
console.log(`# AGENTS.md placement evidence (commits since ${since})`)
console.log(
  [
    "area".padEnd(46),
    "own",
    "nearest AGENTS.md".padEnd(32),
    "commits",
    "fixes",
    "files",
    "languages".padEnd(10),
    "scripts",
  ].join(" "),
)
shown.forEach((row) =>
  console.log(
    [
      row.area.padEnd(46),
      (row.own ? "yes" : "no").padEnd(3),
      row.nearest.padEnd(32),
      String(row.commits).padStart(7),
      String(row.fixes).padStart(5),
      String(row.files).padStart(5),
      row.languages.padEnd(10),
      String(row.scripts).padStart(7),
    ].join(" "),
  ),
)
console.log(
  `\n${shown.filter((row) => !row.own).length} areas without their own AGENTS.md; generated packages/*-wasm skipped; use --all to include areas under 5 files`,
)

// The deepest area containing the file, so a file counts once, for its most specific area.
function owner(file: string) {
  return areas.find((area) => file.startsWith(`${area}/`))
}

function nearestInstructions(area: string) {
  const parts = area.split("/")
  const found = parts
    .map((_, index) => parts.slice(0, parts.length - index).join("/"))
    .find((folder) => instructionFolders.has(folder))
  return found === undefined ? ROOT : `${found}/AGENTS.md`
}

function scriptCount(area: string) {
  if (!tracked.includes(`${area}/package.json`)) return 0
  const parsed: unknown = JSON.parse(readFileSync(path.join(root, area, "package.json"), "utf8"))
  const found = typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : undefined
  return typeof found === "object" && found !== null ? Object.keys(found).length : 0
}

function commits() {
  const log = git(root, "log", `--since=${since}`, "--no-merges", "--format=%x1e%s", "--name-only") ?? ""
  return log
    .split("\x1e")
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const lines = entry.split("\n")
      return { subject: lines[0] ?? "", files: lines.slice(1).filter((line) => line.length > 0) }
    })
}

// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
function git(cwd: string, ...command: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...command], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}
