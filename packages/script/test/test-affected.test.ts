import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runTests, selectAffected } from "../src/test-affected"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test("selects changed packages and transitive workspace consumers, including untracked paths", () => {
  const root = fixture()
  writeFileSync(path.join(root, "packages/a/src.ts"), "changed\n")
  writeFileSync(path.join(root, "packages/b/new.ts"), "untracked\n")

  const result = selectAffected(root, { base: "main", includeWorkingTree: true })

  expect(result.changedPaths).toEqual(["packages/a/src.ts", "packages/b/new.ts"])
  expect(result.selected).toEqual(["packages/a", "packages/b", "packages/c"])
  expect(result.fallbackReason).toBeNull()
})

test("returns no test packages for documentation-only changes", () => {
  const root = fixture()
  writeFileSync(path.join(root, "docs/guide.md"), "text\n")

  const result = selectAffected(root, { base: "main", includeWorkingTree: true })

  expect(result.selected).toEqual([])
  expect(result.fallbackReason).toBeNull()
})

test("selects consumers of packages without tests and excludes unrelated packages", () => {
  const root = fixture()
  writeManifest(root, "packages/library", "library")
  writeManifest(root, "packages/unrelated", "unrelated", "bun -e 'process.exit(0)'")
  writeManifest(root, "packages/a", "a", "bun -e 'process.exit(0)'", {
    library: "workspace:*",
    c: "workspace:*",
  })
  git(root, ["add", "."])
  git(root, ["commit", "-m", "add library and unrelated package"])
  writeFileSync(path.join(root, "packages/library/source.ts"), "changed\n")

  const result = selectAffected(root, { base: "main", includeWorkingTree: true })

  expect(result.selected).toEqual(["packages/a", "packages/b", "packages/c"])
  expect(result.fallbackReason).toBeNull()
})

test("selects runtime markdown and falls back for unknown files and manifests", () => {
  const root = fixture()
  mkdirSync(path.join(root, "packages/a/agents"), { recursive: true })
  writeFileSync(path.join(root, "packages/a/agents/prompt.md"), "runtime\n")
  const runtime = selectAffected(root, { base: "main", includeWorkingTree: true })
  mkdirSync(path.join(root, ".forge/agents"), { recursive: true })
  writeFileSync(path.join(root, ".forge/agents/prompt.md"), "unknown\n")
  const unknown = selectAffected(root, { base: "main", includeWorkingTree: true })
  expect(runtime.fallbackReason).toBeNull()
  expect(runtime.selected).toEqual(["packages/a", "packages/b", "packages/c"])
  expect(unknown.fallbackReason).toContain("outside a known package")
  rmSync(path.join(root, ".forge"), { recursive: true })
  const manifest = JSON.parse(readFileSync(path.join(root, "packages/a/package.json"), "utf8"))
  writeFileSync(path.join(root, "packages/a/package.json"), JSON.stringify({ ...manifest, description: "changed" }))
  const manifestOnly = selectAffected(root, { base: "main", includeWorkingTree: true })
  expect(manifestOnly.fallbackReason).toContain("Workspace manifest")
})

test("keeps both endpoints of renames and deleted paths", () => {
  const root = fixture()
  git(root, ["mv", "packages/a/src.ts", "packages/a/renamed.ts"])

  const result = selectAffected(root, { base: "main", includeWorkingTree: true })

  expect(result.changedPaths).toEqual(["packages/a/renamed.ts", "packages/a/src.ts"])
  expect(result.selected).toEqual(["packages/a", "packages/b", "packages/c"])
})

test("uses committed head changes only and closes transitive, cyclic peer/dev/optional edges", () => {
  const root = fixture()
  writeFileSync(path.join(root, "packages/a/committed.ts"), "committed\n")
  git(root, ["add", "."])
  git(root, ["commit", "-m", "package a change"])
  writeFileSync(path.join(root, "packages/b/dirty.ts"), "dirty\n")

  const result = selectAffected(root, { base: "base", head: "HEAD", includeWorkingTree: false })

  expect(result.changedPaths).toEqual(["packages/a/committed.ts"])
  expect(result.selected).toEqual(["packages/a", "packages/b", "packages/c"])
})

test("falls back for shared configuration changes and missing bases", () => {
  const root = fixture()
  writeFileSync(path.join(root, "bun.lock"), "changed\n")
  const shared = selectAffected(root, { base: "main", includeWorkingTree: true })
  const missingBase = selectAffected(root, { base: "missing", includeWorkingTree: false })

  expect(shared.selected).toEqual(["packages/a", "packages/b", "packages/c"])
  expect(shared.fallbackReason).toContain("Shared configuration")
  expect(missingBase.selected).toEqual(["packages/a", "packages/b", "packages/c"])
  expect(missingBase.fallbackReason).toContain("merge base")
})

test("runs package scripts from their package directories and reports failures", async () => {
  const root = fixture()
  writeManifest(root, "packages/a", "a", "bun -e 'if (!process.cwd().endsWith(\"packages/a\")) process.exit(5)'")
  writeManifest(root, "packages/b", "b", "bun -e 'process.exit(7)'")

  expect(await runTests(root, ["packages/a", "packages/b"])).toEqual(["packages/b"])
})

test("rejects running committed-only head plans", () => {
  const script = path.resolve(import.meta.dir, "../src/test-affected.ts")
  const result = Bun.spawnSync([process.execPath, script, "--run", "--head", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(result.exitCode).not.toBe(0)
  expect(new TextDecoder().decode(result.stderr)).toContain("--run cannot be combined with --head")
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "test-affected-"))
  roots.push(root)
  mkdirSync(path.join(root, "docs"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
  writeManifest(root, "packages/a", "a", "bun -e 'process.exit(0)'", { c: "workspace:*" }, "peerDependencies")
  writeManifest(root, "packages/b", "b", "bun -e 'process.exit(0)'", { a: "workspace:*" }, "devDependencies")
  writeManifest(root, "packages/c", "c", "bun -e 'process.exit(0)'", { b: "workspace:*" }, "optionalDependencies")
  for (const directory of ["packages/a", "packages/b", "packages/c"])
    mkdirSync(path.join(root, directory), { recursive: true })
  git(root, ["init", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "packages/a/src.ts"), "initial\n")
  writeFileSync(path.join(root, "docs/guide.md"), "initial\n")
  git(root, ["add", "."])
  git(root, ["commit", "-m", "initial"])
  git(root, ["tag", "base"])
  return root
}

function writeManifest(
  root: string,
  directory: string,
  name: string,
  script?: string,
  dependencies?: Record<string, string>,
  dependencyField = "dependencies",
) {
  const packageRoot = path.join(root, directory)
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name,
      scripts: script ? { test: script } : undefined,
      [dependencyField]: dependencies,
    }),
  )
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}
