#!/usr/bin/env bun
// Audits the repository's AGENTS.md files, the instructions coding agents load while developing TurenOS.
// Checks what a script can prove: load budget per directory chain, references from ancestors, size, stray @mentions,
// backticked paths and package scripts that don't resolve, broken links, lines repeated across files, lines naming the
// upstream OpenCode product, and the CLAUDE.md shims Claude Code needs to read AGENTS.md at all. Symbols, invariants and
// gotchas still need a human read. The rules live in lib/: instructions.ts (per-file checks and repeats), paths.ts,
// commands.ts and claude.ts.
// Exits 1 when any error is found. Read-only.
//
// usage: bun .agents/skills/turen-context/scripts/check.ts [repo-root]

import path from "node:path"
import { claudeFindings } from "./lib/claude"
import type { Level } from "./lib/findings"
import { duplicateFindings, fileFindings } from "./lib/instructions"
import { chainBytes, loadRepo } from "./lib/repo"

const repo = loadRepo(path.resolve(process.argv[2] ?? "."))
const findings = [
  ...repo.graded.flatMap((file) => fileFindings(repo, file)),
  ...duplicateFindings(repo),
  ...claudeFindings(repo),
]

console.log(`# AGENTS.md audit: ${repo.graded.length} files under ${repo.root}`)
if (repo.vendored.length > 0) {
  console.log(`Vendored instruction files (not graded; they load for agents working in those folders):`)
  repo.vendored.forEach((file) => console.log(`  ${file} (${chainBytes(repo, file)} B chain)`))
}
repo.graded.forEach((file) => {
  const own = findings.filter((finding) => finding.file === file)
  const text = repo.texts.get(file) ?? ""
  console.log(
    `\n## ${file}: ${text.split("\n").length} lines, ${Buffer.byteLength(text)} B, chain ${chainBytes(repo, file)} B`,
  )
  if (own.length === 0)
    console.log("- no mechanical findings; still verify symbols, invariants and gotchas by reading the code")
  own.forEach((finding) => console.log(`- ${finding.level.toUpperCase()}: ${finding.message}`))
})
const crossFile = findings.filter((finding) => finding.file === "")
if (crossFile.length > 0) {
  console.log("\n## Across files")
  crossFile.forEach((finding) => console.log(`- ${finding.level.toUpperCase()}: ${finding.message}`))
}
const count = (level: Level) => findings.filter((finding) => finding.level === level).length
console.log(`\n${count("error")} errors, ${count("warning")} warnings, ${count("note")} notes`)
process.exit(count("error") > 0 ? 1 : 0)
