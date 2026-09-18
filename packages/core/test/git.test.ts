import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Git } from "@turenlabs/core/git"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { branch, commit, gitRemote, runGit } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

describe("Git", () => {
  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, { branch: "feature/docs" })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

async function initRepo(directory: string) {
  await runGit(directory, "init")
  await runGit(directory, "config", "core.fsmonitor", "false")
  await runGit(directory, "config", "commit.gpgsign", "false")
  await runGit(directory, "config", "user.email", "test@forge.test")
  await runGit(directory, "config", "user.name", "Test")
  await runGit(directory, "commit", "--allow-empty", "-m", "root")
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(directory)
      if (!repo) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: repo, directory: worktree })

      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(repo.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(repo.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({ repository: linked, directory: worktree, force: false })
      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})

describe("Git trees", () => {
  it.live("skips oversized untracked files while refreshing a large scope", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const small = Array.from({ length: 64 }, (_, index) => `scope/small-${String(index).padStart(2, "0")}.txt`)
      const oversized = Array.from(
        { length: 64 },
        (_, index) => `scope/oversized-${String(index).padStart(2, "0")}.txt`,
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await Promise.all([
          ...small.map((file) => fs.writeFile(path.join(root.path, file), "ok")),
          ...oversized.map((file) => fs.writeFile(path.join(root.path, file), "too large")),
        ])
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const repository = yield* git.repo.create({
        worktree: source.worktree,
        gitDirectory: AbsolutePath.make(path.join(root.path, ".snapshot")),
        seed: source,
      })
      const before = yield* git.tree.write(repository)

      const result = yield* git.index.refresh({
        repository,
        scope: RelativePath.make("scope"),
        maximumUntrackedFileBytes: 2,
      })
      const after = yield* git.tree.write(repository)

      expect(result.skipped).toEqual(oversized.map((file) => RelativePath.make(file)))
      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual(
        small.map((file) => RelativePath.make(file)),
      )
    }),
  )

  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "one\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "outside\n")
        await runGit(root.path, "add", ".")
        await runGit(root.path, "commit", "-m", "initial")
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 1 })
      expect(diffs.map((item) => [item.path, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      const preview = yield* git.tree.preview({ repository, current: after, files, context: 1 })
      expect(preview).toHaveLength(1)
      expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )
})

describe("Git index", () => {
  it.live("rebuilds a poisoned index wholesale when stale entries exceed the bulk threshold", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const project = path.join(root.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project)
        await initRepo(project)
        await fs.writeFile(path.join(project, ".gitignore"), "build/\n")
        await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
        await runGit(project, "add", ".")
        await runGit(project, "commit", "-qm", "tracked")
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(project))
      if (!source) throw new Error("Repository not found")
      const repository = yield* git.repo.create({
        worktree: source.worktree,
        gitDirectory: AbsolutePath.make(path.join(root.path, "shadow")),
        seed: source,
      })
      // A failed ignore check once staged ignored build output; reproduce it by
      // injecting stale entries straight into the shadow index.
      yield* Effect.promise(async () => {
        const { stdout: blob } = await runGit(project, "rev-parse", "HEAD:tracked.txt")
        const entries = Array.from(
          { length: Git.BULK_REBUILD_THRESHOLD + 1 },
          (_, index) => `100644 ${blob.trim()}\tbuild/stale-${index}.txt`,
        ).join("\n")
        const child = Bun.spawn(
          [
            "git",
            "--git-dir",
            repository.gitDirectory,
            "--work-tree",
            repository.worktree,
            "update-index",
            "--index-info",
          ],
          { cwd: project, stdin: new Blob([entries + "\n"]) },
        )
        await child.exited
        expect(child.exitCode).toBe(0)
      })

      yield* git.tree.capture({ repository, scopes: [RelativePath.make(".")], ignores: source })

      const lines = yield* TestConsole.logLines
      expect(lines.some((line) => String(line).includes("refresh bulk rebuild"))).toBe(true)
      const { stdout: files } = yield* Effect.promise(() =>
        runGit(project, "--git-dir", repository.gitDirectory, "--work-tree", repository.worktree, "ls-files"),
      )
      expect(files.split("\n").filter(Boolean)).toEqual([".gitignore", "tracked.txt"])
    }),
  )

  it.live("fails instead of staging untracked files when the ignore check errors", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const project = path.join(root.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project)
        await initRepo(project)
        await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
        await fs.writeFile(path.join(project, "untracked.txt"), "new\n")
        await runGit(project, "add", "tracked.txt")
        await runGit(project, "commit", "-qm", "tracked")
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(project))
      if (!source) throw new Error("Repository not found")
      const repository = yield* git.repo.create({
        worktree: source.worktree,
        gitDirectory: AbsolutePath.make(path.join(root.path, "shadow")),
        seed: source,
      })
      const broken = new Git.Repository({
        worktree: source.worktree,
        gitDirectory: AbsolutePath.make(path.join(root.path, "missing-git")),
        commonDirectory: AbsolutePath.make(path.join(root.path, "missing-git")),
      })

      const exit = yield* git.index
        .refresh({ repository, scope: RelativePath.make("."), ignores: broken })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const { stdout: files } = yield* Effect.promise(() =>
        runGit(project, "--git-dir", repository.gitDirectory, "--work-tree", repository.worktree, "ls-files"),
      )
      expect(files.split("\n").filter(Boolean)).toEqual(["tracked.txt"])
    }),
  )
})
