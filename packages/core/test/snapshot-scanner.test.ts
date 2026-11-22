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
    SnapshotScanner.make({ resources, env: { ...env, GIT_INDEX_FILE: path.join(worktree, "alternate.index") } }),
  ).toBeUndefined()
  const scanner = SnapshotScanner.make({ resources, env })
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

test.skipIf(!resources)("the staged worker writes shadow trees with Git-compatible fallback", async () => {
  await using root = await tmpdir()
  const worktree = path.join(root.path, "worktree")
  const shadowRoot = path.join(root.path, "snapshot")
  const gitDirectory = path.join(shadowRoot, "project", "checkout")
  await mkdir(gitDirectory, { recursive: true })
  await mkdir(worktree)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "--git-dir", gitDirectory, "--work-tree", worktree, ...args], {
      cwd: worktree,
      env,
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git("init", "-q")
  git("config", "index.version", "4")
  await Bun.write(path.join(worktree, "script\nname"), "#!/bin/sh\n")
  await chmod(path.join(worktree, "script\nname"), 0o755)
  await symlink("script\nname", path.join(worktree, "link"))
  git("add", ".")
  const index = path.join(gitDirectory, "index")
  const original = await Bun.file(index).arrayBuffer()

  const scanner = SnapshotScanner.make({
    resources,
    env: { ...env, HOME: root.path, XDG_CONFIG_HOME: root.path },
    shadowRoot,
  })
  expect(scanner).toBeDefined()
  if (!scanner) return
  const signal = new AbortController().signal
  try {
    const [tree, scan] = await Promise.all([
      scanner.writeTree(gitDirectory, signal),
      scanner.scan({ gitDirectory, worktree, scope: "." }, signal),
    ])
    expect(scan).toEqual([[], []])
    if (!tree) throw new Error("expected a tree from the snapshot worker")
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
    expect(await Bun.file(index).arrayBuffer()).toEqual(original)
    expect(git("cat-file", "-t", tree)).toBe("tree")
    expect(tree).toBe(git("write-tree"))
    expect(await scanner.writeTree(worktree, signal)).toBeUndefined()
    git("update-index", "--add", "--cacheinfo", "160000", "1".repeat(40), "nested")
    expect(await scanner.writeTree(gitDirectory, signal)).toBe(git("write-tree"))
    git("update-index", "--force-remove", "nested")

    git("config", "core.fsync", "all")
    expect(await scanner.writeTree(gitDirectory, signal)).toBeUndefined()
    git("config", "--unset", "core.fsync")
    await Bun.write(path.join(worktree, "intent.txt"), "pending\n")
    git("add", "-N", "intent.txt")
    expect(await scanner.writeTree(gitDirectory, signal)).toBeUndefined()
    expect(git("write-tree")).toBe(tree)
    git("reset", "--", "intent.txt")
    git("update-index", "--split-index")
    expect(await scanner.writeTree(gitDirectory, signal)).toBeUndefined()
    git("update-index", "--no-split-index")
    expect(await scanner.writeTree(gitDirectory, signal)).toBe(tree)

    const objects = path.join(gitDirectory, "objects")
    const outside = path.join(root.path, "redirect")
    await rename(objects, outside)
    await symlink(outside, objects)
    expect(await scanner.writeTree(gitDirectory, signal)).toBeUndefined()
    const relocated = path.join(root.path, "redirected-repository")
    await rename(gitDirectory, relocated)
    await symlink(relocated, gitDirectory)
    expect(await scanner.writeTree(gitDirectory, signal)).toBeUndefined()
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
    const scanner = SnapshotScanner.make({ resources: root.path, env, shadowRoot: root.path })
    expect(scanner).toBeDefined()
    if (!scanner) return

    const input = { gitDirectory: root.path, worktree: root.path, scope: "." }
    const signal = new AbortController().signal
    try {
      expect(await scanner.scan(input, signal)).toBeUndefined()
      expect(await scanner.scan(input, signal)).toBeUndefined()
      expect(await scanner.writeTree(path.join(root.path, "project", "checkout"), signal)).toBeUndefined()
      expect(await Bun.file(binary + ".starts").text()).toBe("start\n")
    } finally {
      await scanner.close()
    }
  },
)
