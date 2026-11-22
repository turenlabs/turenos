import { expect, test } from "bun:test"
import { chmod, mkdir, rename, symlink } from "node:fs/promises"
import path from "node:path"
import { SnapshotScanner } from "@turenlabs/core/snapshot/scanner"
import { tmpdir } from "./fixture/tmpdir"

const resources = process.env.FORGE_RESOURCES_PATH
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }

test.skipIf(!resources)("the staged Rust worker matches concurrent Git scans", async () => {
  await using root = await tmpdir()
  const worktree = root.path
  const gitDirectory = path.join(worktree, ".git")
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: worktree, env })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString()
  }
  git("init", "-q")
  await mkdir(path.join(worktree, "scope"))
  await Bun.write(path.join(worktree, "scope", "tracked.txt"), "before\n")
  await Bun.write(path.join(worktree, ".gitignore"), "*.ignored\n")
  const nested = path.join(worktree, "nested")
  await mkdir(nested)
  git("-C", nested, "init", "-q")
  await Bun.write(path.join(nested, "note.txt"), "nested version one\n")
  git("-C", nested, "add", "note.txt")
  git(
    "-C",
    nested,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "seed",
  )
  git("add", ".")
  await Bun.write(path.join(nested, "note.txt"), "dirty nested checkout\n")
  await Bun.write(path.join(worktree, "scope", "tracked.txt"), "after\n")
  await Bun.write(path.join(worktree, "scope", "a b.txt"), "untracked\n")
  await Bun.write(path.join(worktree, "scope", "skip.ignored"), "excluded\n")
  await Bun.write(path.join(worktree, "outside.txt"), "outside\n")

  expect(
    SnapshotScanner.make(resources, { ...env, GIT_INDEX_FILE: path.join(worktree, "alternate.index") }),
  ).toBeUndefined()
  const scanner = SnapshotScanner.make(resources, env)
  expect(scanner).toBeDefined()
  if (!scanner) return
  const signal = new AbortController().signal
  const scopes = [".", "scope", "scope/tracked.txt", ".", "scope"]
  try {
    const scans = await Promise.all(scopes.map((scope) => scanner.scan({ gitDirectory, worktree, scope }, signal)))
    const list = (stdout: string) => stdout.split("\0").filter(Boolean).sort()
    scans.forEach((scan, index) => {
      const scope = scopes[index]!
      expect(scan?.map((files) => [...files].sort())).toEqual([
        list(git("diff-files", "--ignore-submodules=dirty", "--name-only", "-z", "--", scope)),
        list(git("ls-files", "--others", "--exclude-standard", "-z", "--", scope)),
      ])
    })
    expect(await scanner.scan({ gitDirectory: ".git", worktree, scope: "." }, signal)).toBeUndefined()
    await rename(path.join(worktree, "scope"), path.join(worktree, "moved-scope"))
    await symlink("moved-scope", path.join(worktree, "scope"))
    expect(await scanner.scan({ gitDirectory, worktree, scope: "." }, signal)).toBeUndefined()
  } finally {
    await scanner.close()
  }
})

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "an exiting snapshot worker returns to Git without repeatedly spawning",
  async () => {
    await using root = await tmpdir()
    const directory = path.join(root.path, "snapshot-scan")
    await mkdir(directory)
    const binary = path.join(directory, "turen-snapshot")
    await Bun.write(binary, '#!/bin/sh\nprintf "start\\n" >> "$0.starts"\nexit 77\n')
    await chmod(binary, 0o755)
    await Bun.write(path.join(directory, "snapshot-scan.gitconfig"), "[diff]\nignoreSubmodules = dirty\n")
    const scanner = SnapshotScanner.make(root.path, env)
    expect(scanner).toBeDefined()
    if (!scanner) return

    const input = { gitDirectory: root.path, worktree: root.path, scope: "." }
    const signal = new AbortController().signal
    try {
      expect(await scanner.scan(input, signal)).toBeUndefined()
      expect(await scanner.scan(input, signal)).toBeUndefined()
      expect(await Bun.file(binary + ".starts").text()).toBe("start\n")
    } finally {
      await scanner.close()
    }
  },
)
