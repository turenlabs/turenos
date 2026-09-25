import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

test("splitting rewrites untracked Markdown links without rewriting fenced examples", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-split-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    mkdirSync(path.join(root, "docs/systems/topic"), { recursive: true })
    writeFileSync(path.join(root, "docs/systems/topic/README.md"), "# Topic\n\n## Details\n\nDetails here.\n")
    writeFileSync(
      path.join(root, "README.md"),
      "[Details](./docs/systems/topic/README.md#details)\n\n```md\n[Example](./docs/systems/topic/README.md#details)\n```\n",
    )
    const result = Bun.spawnSync(
      [
        "bun",
        path.join(import.meta.dir, "split.ts"),
        "docs/systems/topic/README.md",
        "--into",
        "details.md",
        "--title",
        "Details",
        "--section",
        "Details",
        "--apply",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain(
      "[Details](./docs/systems/topic/details.md#details)\n\n```md\n[Example](./docs/systems/topic/README.md#details)\n```",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a split with duplicate heading slugs refuses to rewrite ambiguous anchors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-split-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    mkdirSync(path.join(root, "docs/systems/topic"), { recursive: true })
    const original = "# Topic\n\n## Intro\n\n### Same\n\n## Details\n\n### Same\n"
    writeFileSync(path.join(root, "docs/systems/topic/README.md"), original)
    writeFileSync(path.join(root, "README.md"), "[Second](./docs/systems/topic/README.md#same-1)\n")
    const result = Bun.spawnSync(
      [
        "bun",
        path.join(import.meta.dir, "split.ts"),
        "docs/systems/topic/README.md",
        "--into",
        "details.md",
        "--title",
        "Details",
        "--section",
        "Details",
        "--apply",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("duplicate heading")
    expect(readFileSync(path.join(root, "docs/systems/topic/README.md"), "utf8")).toBe(original)
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toContain("#same-1")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
