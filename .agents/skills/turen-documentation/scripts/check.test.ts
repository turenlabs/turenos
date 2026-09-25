import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "turen-doc-check-"))
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
    mkdirSync(path.join(root, "docs/architecture"), { recursive: true })
    mkdirSync(path.join(root, "docs/systems"), { recursive: true })
    writeFileSync(
      path.join(root, "docs/README.md"),
      "# Docs\n\n[Architecture](./architecture/README.md)\n[Systems](./systems/README.md)\n",
    )
    writeFileSync(path.join(root, "docs/architecture/README.md"), "# Architecture\n")
    writeFileSync(path.join(root, "docs/systems/README.md"), "# Systems\n\n[API](./api.md)\n")
    writeFileSync(path.join(root, "docs/systems/api.md"), "# API\n\n### `Tool.make`\n\n## Source\n")
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function check(root: string, ...flags: string[]) {
  const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "check.ts"), "docs", ...flags], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

test("resolves inline-code heading anchors and reports malformed percent-encoding", () =>
  fixture((root) => {
    writeFileSync(
      path.join(root, "docs/README.md"),
      "# Docs\n\n[Architecture](./architecture/README.md)\n[Systems](./systems/README.md)\n[Tool](./systems/api.md#toolmake)\n",
    )
    expect(check(root)).toMatchObject({ code: 0 })
    writeFileSync(
      path.join(root, "docs/README.md"),
      "# Docs\n\n[Architecture](./architecture/README.md)\n[Systems](./systems/README.md)\n[Bad](./systems/api%zz.md)\n",
    )
    const result = check(root)
    expect(result.code).toBe(1)
    expect(result.output).toContain("malformed percent-encoding")
    expect(result.output).not.toContain("URIError")
  }))

test("checks relative docs links outside docs without treating broken links as root mentions", () =>
  fixture((root) => {
    mkdirSync(path.join(root, "packages/example"), { recursive: true })
    writeFileSync(
      path.join(root, "packages/example/README.md"),
      "[Bad](./docs/systems/gone.md)\n[Also bad](docs/systems/api.md)\n[Good](../../docs/systems/api.md#toolmake)\n",
    )
    const result = check(root)
    expect(result.code).toBe(1)
    expect(result.output).toContain("./docs/systems/gone.md")
    expect(result.output).toContain("docs/systems/api.md, which does not exist relative to this file")
    expect(result.output).not.toContain("api.md#toolmake, which has no such heading")
  }))

test("coverage follows declared workspaces including nested packages", () =>
  fixture((root) => {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/*", "packages/sdk/js"] } }),
    )
    mkdirSync(path.join(root, "packages/sdk/js"), { recursive: true })
    mkdirSync(path.join(root, "command-guard"), { recursive: true })
    writeFileSync(path.join(root, "packages/sdk/js/package.json"), "{}")
    writeFileSync(path.join(root, "command-guard/package.json"), "{}")
    const result = check(root, "--coverage")
    expect(result.code).toBe(0)
    expect(result.output).toContain("no docs page mentions packages/sdk/js")
    expect(result.output).not.toContain("no docs page mentions command-guard")
  }))
