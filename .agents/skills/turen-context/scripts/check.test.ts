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

test("every nested AGENTS.md needs a sibling CLAUDE.md shim, since Claude Code never follows prose pointers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-context-check-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, "AGENTS.md"), "- follow `pkg/AGENTS.md` when working in `pkg/`\n")
    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n")
    mkdirSync(path.join(root, "pkg"))
    writeFileSync(path.join(root, "pkg/AGENTS.md"), "- package rule\n")
    const check = () =>
      Bun.spawnSync(["bun", path.join(import.meta.dir, "check.ts"), root], { stdout: "pipe", stderr: "pipe" })
    const missing = check()
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout.toString()).toContain("pkg/AGENTS.md has no sibling CLAUDE.md")
    writeFileSync(path.join(root, "pkg/CLAUDE.md"), "@AGENTS.md\n")
    expect(check().exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("skills need strict-YAML frontmatter that follows the Agent Skills rules, and a root AGENTS.md pointer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-context-check-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, "AGENTS.md"), "- follow `.agents/skills/demo/SKILL.md` for demos\n")
    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n")
    mkdirSync(path.join(root, ".agents/skills/demo"), { recursive: true })
    mkdirSync(path.join(root, ".agents/skills/other"), { recursive: true })
    const skill = (frontmatter: string) =>
      writeFileSync(path.join(root, ".agents/skills/demo/SKILL.md"), `---\n${frontmatter}\n---\n\n# Demo\n`)
    const check = () => {
      const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "check.ts"), root], { stdout: "pipe" })
      return { code: result.exitCode, output: result.stdout.toString() }
    }
    skill("name: demo\ndescription: Checks demos. Use it when asked about demos.")
    writeFileSync(path.join(root, ".agents/skills/other/SKILL.md"), "---\nname: other\ndescription: Other.\n---\n")
    const unlisted = check()
    expect(unlisted.code).toBe(1)
    expect(unlisted.output).toContain(".agents/skills/other/SKILL.md is not named in the root AGENTS.md")
    expect(unlisted.output).not.toContain("demo/SKILL.md")
    rmSync(path.join(root, ".agents/skills/other"), { recursive: true })
    expect(check().code).toBe(0)
    skill("name: demo\ndescription: Checks what a script can: links and paths.")
    const colon = check()
    expect(colon.code).toBe(1)
    expect(colon.output).toContain("frontmatter is not valid YAML")
    expect(colon.output).toContain('its `description` value contains an unquoted ": "')
    skill(`name: Demo_Skill\ndescription: ${"x".repeat(1025)}\nargument-hint: <file>`)
    const invalid = check().output
    expect(invalid).toContain("`name` must be 1-64 lowercase letters")
    expect(invalid).toContain("`name` must match its folder, `demo`")
    expect(invalid).toContain("`description` is 1025 characters")
    expect(invalid).toContain("field `argument-hint` is not in the Agent Skills specification")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports a deleted-but-tracked AGENTS.md instead of crashing, and refuses to run outside git", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-context-check-"))
  const loose = mkdtempSync(path.join(tmpdir(), "turen-context-nogit-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, "AGENTS.md"), "- rule\n")
    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n")
    mkdirSync(path.join(root, "pkg"))
    writeFileSync(path.join(root, "pkg/AGENTS.md"), "- package rule\n")
    expect(Bun.spawnSync(["git", "add", "."], { cwd: root }).exitCode).toBe(0)
    rmSync(path.join(root, "pkg/AGENTS.md"))
    const run = (dir: string) =>
      Bun.spawnSync(["bun", path.join(import.meta.dir, "check.ts"), dir], { stdout: "pipe", stderr: "pipe" })
    const deleted = run(root)
    expect(deleted.stderr.toString()).not.toContain("ENOENT")
    expect(deleted.exitCode).toBe(0)
    writeFileSync(path.join(loose, "AGENTS.md"), "- rule\n")
    const outside = run(loose)
    expect(outside.exitCode).toBe(2)
    expect(outside.stderr.toString()).toContain("not inside a git repository")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(loose, { recursive: true, force: true })
  }
})
