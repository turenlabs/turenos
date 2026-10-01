import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PAGE = [
  "# Widgets",
  "",
  "`MAX_WIDGETS` caps the list at 5 (`src/config.ts`). Set `FORGE_WIDGET_DIR` to move it.",
  "`legacyThing` in [`src/legacy.ts`](../../src/legacy.ts) still loads old widgets.",
  "Run `forge widgets --dry-run` first. `src/config.tsx` is a different file.",
  "",
].join("\n")

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "turen-diff-docs-"))
  try {
    expect(git(root, "init", "-q", "-b", "main")).toBe(0)
    mkdirSync(path.join(root, "src/old"), { recursive: true })
    mkdirSync(path.join(root, "docs/systems"), { recursive: true })
    writeFileSync(
      path.join(root, "src/config.ts"),
      'export const MAX_WIDGETS = 5\nexport const dir = process.env["FORGE_WIDGET_DIR"]\n',
    )
    writeFileSync(path.join(root, "src/legacy.ts"), "export function legacyThing() {}\n")
    writeFileSync(path.join(root, "src/old/shim.ts"), "export const shim = 1\n")
    writeFileSync(path.join(root, "src/cli.ts"), 'cli.option("dry-run", {})\n')
    writeFileSync(path.join(root, "docs/systems/widgets.md"), PAGE + "Shims live in `src/old`.\n")
    commit(root, "base")
    expect(git(root, "checkout", "-q", "-b", "feature")).toBe(0)
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function git(root: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root }).exitCode
}

function commit(root: string, message: string) {
  expect(git(root, "add", "-A")).toBe(0)
  expect(git(root, "commit", "-q", "-m", message)).toBe(0)
}

function affected(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "affected.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

test("reports stale citations, changed constants and new undocumented names, including uncommitted files", () =>
  fixture((root) => {
    writeFileSync(
      path.join(root, "src/config.ts"),
      'export const MAX_WIDGETS = 10\nexport const dir = process.env["FORGE_WIDGET_PATH"]\n',
    )
    rmSync(path.join(root, "src/legacy.ts"))
    rmSync(path.join(root, "src/old"), { recursive: true })
    writeFileSync(path.join(root, "src/cli.ts"), 'cli.option("dry-run", {})\ncli.option("force-all", {})\n')
    commit(root, "change")
    writeFileSync(
      path.join(root, "src/extra.ts"),
      '// FORGE_COMMENT_ONLY is prose\nexport const mode = process.env["FORGE_EXTRA_MODE"]\n',
    )

    const result = affected(root, "main")
    expect(result.code).toBe(1)
    expect(result.output).toContain("docs/systems/widgets.md:4 cites `src/legacy.ts`, deleted in this diff")
    expect(result.output).toContain("docs/systems/widgets.md:4 names `legacyThing`, the export this diff removed")
    expect(result.output).toContain("docs/systems/widgets.md:3 names `FORGE_WIDGET_DIR`, the env var this diff removed")
    expect(result.output).toContain("docs/systems/widgets.md:6 cites `src/old`, a folder this diff removed")
    // Line 5 names `src/config.tsx`, a different file, so only line 3 cites `src/config.ts`.
    expect(result.output).toContain("`src/config.ts` (modified), line 3; `MAX_WIDGETS` 5 -> 10")
    expect(result.output).toContain("`--force-all` (CLI option) in `src/cli.ts`")
    expect(result.output).toContain("`FORGE_WIDGET_PATH` (env var) in `src/config.ts`")
    expect(result.output).toContain("`FORGE_EXTRA_MODE` (env var) in `src/extra.ts`")
    expect(result.output).not.toContain("`--dry-run` (CLI option)")
    expect(result.output).not.toContain("FORGE_COMMENT_ONLY")
  }))

test("compares to a commit with --head, ignoring the working tree, and reports renames", () =>
  fixture((root) => {
    expect(git(root, "mv", "src/config.ts", "src/settings.ts")).toBe(0)
    commit(root, "rename")
    writeFileSync(path.join(root, "src/extra.ts"), 'export const mode = process.env["FORGE_EXTRA_MODE"]\n')

    const result = affected(root, "main", "--head", "feature")
    expect(result.code).toBe(1)
    expect(result.output).toContain("cites `src/config.ts`, renamed to `src/settings.ts` in this diff")
    expect(result.output).not.toContain("FORGE_EXTRA_MODE")
  }))

test("passes when nothing stale is cited, and names the Markdown the diff edits", () =>
  fixture((root) => {
    writeFileSync(path.join(root, "docs/systems/widgets.md"), PAGE.replace("5", "7"))
    writeFileSync(
      path.join(root, "src/config.ts"),
      'export const MAX_WIDGETS = 7\nexport const dir = process.env["FORGE_WIDGET_DIR"]\n',
    )

    const result = affected(root, "main")
    expect(result.code).toBe(0)
    expect(result.output).toContain("Stale references (fix these): 0")
    expect(result.output).toContain("`docs/systems/widgets.md` (modified)")
    expect(result.output).toContain("`MAX_WIDGETS` 5 -> 7; named at docs/systems/widgets.md:3")
  }))

test("stops instead of reporting nothing when the base doesn't exist", () =>
  fixture((root) => {
    const result = affected(root, "no-such-branch")
    expect(result.code).toBe(2)
    expect(result.output).toContain("failed")
  }))
