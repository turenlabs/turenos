import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

test("moving a page rewrites root docs links without changing area docs links", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-move-"))
  try {
    mkdirSync(path.join(root, "docs"))
    mkdirSync(path.join(root, "packages/example/docs"), { recursive: true })
    writeFileSync(path.join(root, "docs/a.md"), "# Guide\n\n`docs/a.md`\n\n```md\n`docs/a.md`\n```\n")
    writeFileSync(path.join(root, "packages/example/docs/a.md"), "# Package guide\n")
    writeFileSync(
      path.join(root, "README.md"),
      "[Guide](docs/a.md)\n[Explicit](./docs/a.md)\n[Package guide](packages/example/docs/a.md)\n",
    )
    writeFileSync(path.join(root, "packages/example/README.md"), "[Guide](../../docs/a.md)\n")
    writeFileSync(path.join(root, "moves.txt"), "a.md -> a/README.md\n")
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "add", "."], { cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, "new.md"), "[Guide](docs/a.md)\n")

    const result = Bun.spawnSync(
      ["bun", path.join(import.meta.dir, "move.ts"), "moves.txt", "--docs", "docs", "--apply"],
      { cwd: root },
    )
    expect(result.exitCode).toBe(0)
    const readme = readFileSync(path.join(root, "README.md"), "utf8")
    expect(readme).toContain("[Guide](docs/a/README.md)")
    expect(readme).toContain("[Explicit](docs/a/README.md)")
    expect(readme).toContain("[Package guide](packages/example/docs/a.md)")
    expect(readFileSync(path.join(root, "packages/example/README.md"), "utf8")).toContain(
      "[Guide](../../docs/a/README.md)",
    )
    expect(readFileSync(path.join(root, "new.md"), "utf8")).toContain("[Guide](docs/a/README.md)")
    expect(readFileSync(path.join(root, "docs/a/README.md"), "utf8")).toContain(
      "`docs/a/README.md`\n\n```md\n`docs/a.md`\n```",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("empty-folder cleanup never follows a symlink out of docs/", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-move-"))
  const outside = mkdtempSync(path.join(tmpdir(), "turen-doc-outside-"))
  try {
    mkdirSync(path.join(root, "docs"))
    mkdirSync(path.join(outside, "empty-child"))
    writeFileSync(path.join(root, "docs/a.md"), "# A\n")
    symlinkSync(outside, path.join(root, "docs/link"))
    writeFileSync(path.join(root, "moves.txt"), "a.md -> b.md\n")
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    const result = Bun.spawnSync(
      ["bun", path.join(import.meta.dir, "move.ts"), "moves.txt", "--docs", "docs", "--apply"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
    expect(existsSync(path.join(root, "docs/b.md"))).toBe(true)
    expect(existsSync(path.join(outside, "empty-child"))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("refuses unsafe move lists before changing anything", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-move-"))
  const outside = mkdtempSync(path.join(tmpdir(), "turen-doc-outside-"))
  try {
    mkdirSync(path.join(root, "docs/guides"), { recursive: true })
    writeFileSync(path.join(root, "docs/a.md"), "# A\n")
    writeFileSync(path.join(root, "docs/b.md"), "# B\n")
    writeFileSync(path.join(root, "docs/guides/g.md"), "# G\n")
    writeFileSync(path.join(root, "docs/README.md"), "[A](./a.md)\n")
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    const refused = (moves: string, message: string) => {
      writeFileSync(path.join(root, "moves.txt"), moves)
      const result = Bun.spawnSync(
        ["bun", path.join(import.meta.dir, "move.ts"), "moves.txt", "--docs", "docs", "--apply"],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(message)
      expect(readFileSync(path.join(root, "docs/a.md"), "utf8")).toBe("# A\n")
      expect(readFileSync(path.join(root, "docs/b.md"), "utf8")).toBe("# B\n")
      expect(readFileSync(path.join(root, "docs/README.md"), "utf8")).toBe("[A](./a.md)\n")
    }
    refused("a.md -> c.md\nb.md -> C.md\n", "two moves target")
    refused(`a.md -> ${outside}/x.md\n`, "outside the repository")
    refused("guides -> old-guides\n", "not a file")
    refused("a.md -> b.md/c.md\n", "is a file")
    expect(existsSync(path.join(outside, "x.md"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("rewrites percent-encoded links to a moved page", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-move-"))
  try {
    mkdirSync(path.join(root, "docs"))
    writeFileSync(path.join(root, "docs/my page.md"), "# P\n")
    writeFileSync(path.join(root, "docs/README.md"), "[P](./my%20page.md#p)\n")
    writeFileSync(path.join(root, "moves.txt"), "my page.md -> new page.md\n")
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    const result = Bun.spawnSync(
      ["bun", path.join(import.meta.dir, "move.ts"), "moves.txt", "--docs", "docs", "--apply"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
    expect(readFileSync(path.join(root, "docs/README.md"), "utf8")).toBe("[P](./new%20page.md#p)\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
