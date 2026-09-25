import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

test("Claude Code requires a root import shim with no private rules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-context-check-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, "AGENTS.md"), "# Rules\n")
    const check = () =>
      Bun.spawnSync(["bun", path.join(import.meta.dir, "check.ts"), root], { stdout: "pipe", stderr: "pipe" })
    expect(check().stdout.toString()).toContain("no root CLAUDE.md")
    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n")
    expect(check().exitCode).toBe(0)
    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\nClaude-only rule\n")
    expect(check().stdout.toString()).toContain("only Claude Code reads them")
    mkdirSync(path.join(root, "pkg"))
    writeFileSync(path.join(root, "pkg/CLAUDE.md"), "# Separate rules\n")
    expect(check().stdout.toString()).toContain("pkg/CLAUDE.md does not import a sibling AGENTS.md")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
