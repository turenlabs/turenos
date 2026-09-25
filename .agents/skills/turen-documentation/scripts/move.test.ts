import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
