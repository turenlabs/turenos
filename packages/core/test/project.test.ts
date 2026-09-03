import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Schema } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectDirectories } from "@turenlabs/core/project/directories"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Storage } from "@turenlabs/core/storage"
import { Hash } from "@turenlabs/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ProjectV2.node, Database.node, ProjectDirectories.node, Storage.node])),
)

function remoteID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

async function initRepo(dir: string, opts?: { commit?: boolean; remote?: string }) {
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email test@forge.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  if (opts?.commit) await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  if (opts?.remote) await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
}

async function rootCommit(dir: string) {
  return (await $`git rev-list --max-parents=0 HEAD`.cwd(dir).text()).trim()
}

describe("ProjectV2.resolve", () => {
  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(path.resolve(result.directory)).toBe(path.parse(tmp.path).root)
      expect(result.previous).toBeUndefined()
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("returns git global for repo with no commits and no remote", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("falls back to root commit when origin is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers normalized origin over root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:Acme/App.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("normalizes ssh and https remotes to the same id", () =>
    Effect.gen(function* () {
      const ssh = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const https = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(ssh.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => initRepo(https.path, { commit: true, remote: "https://github.com/owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).toBe(remoteID("github.com/owner/repo"))
      expect(b.id).toBe(a.id)
    }),
  )

  it.live("ignores file remotes and falls back to root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: `file://${tmp.path}` }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("returns previous cached id from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      // An identity we already hold outranks the remote, so renaming or
      // repointing the repository cannot re-key a directory that never moved.
      expect(result.id).toBe(ProjectV2.ID.make("old-id"))
    }),
  )

  it.live("keeps its identity when the git remote is renamed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const first = yield* project.resolve(abs(tmp.path))
      expect(first.id).toBe(remoteID("github.com/owner/repo"))

      yield* Effect.promise(() => $`git remote set-url origin git@github.com:owner/renamed.git`.cwd(tmp.path).quiet())

      expect((yield* project.resolve(abs(tmp.path))).id).toBe(first.id)
    }),
  )

  it.live("uses a legacy marker only when SQL has no project identity", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const marker = path.join(tmp.path, ".git", "opencode")
      yield* Effect.promise(() => Bun.write(marker, "legacy-project\n"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("legacy-project"))
      expect(result.previous).toBe(ProjectV2.ID.make("legacy-project"))
      expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("legacy-project\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "forge")).exists())).toBe(false)
    }),
  )

  it.live("fails closed when a legacy marker cannot be read", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const store = AbsolutePath.make(path.join(tmp.path, ".git"))
      yield* Effect.promise(() => fs.mkdir(path.join(store, "forge")))
      yield* Effect.promise(() => Bun.write(path.join(store, "opencode"), "unsafe-fallback\n"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path)).pipe(Effect.exit)
      const storage = yield* Storage.Service

      expect(Exit.isFailure(result)).toBe(true)
      expect(
        yield* storage.get({
          scope: Storage.Scope.make("internal/project-identity"),
          key: Storage.Key.make(store),
        }),
      ).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(path.join(store, "opencode")).text())).toBe("unsafe-fallback\n")
    }),
  )

  it.live("prefers the SQL project identity over a conflicting legacy marker", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const directory = yield* real(tmp.path)
      const destination = ProjectV2.ID.make("sql-project")
      const marker = path.join(tmp.path, ".git", "forge")
      yield* Effect.promise(() => Bun.write(marker, "marker-project\n"))
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: destination, worktree: directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const projectDirectories = yield* ProjectDirectories.Service
      yield* projectDirectories.create({ projectID: destination, directory })
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(destination)
      expect(result.previous).toBe(destination)
      expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("marker-project\n")
    }),
  )

  it.live("remembers a repository identity in Storage idempotently", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/remembered.git" }))
      const project = yield* ProjectV2.Service
      const first = yield* project.resolve(abs(tmp.path))
      const store = first.vcs?.store
      if (!store) throw new Error("Expected a git store")

      yield* project.remember({ store, id: first.id })
      yield* project.remember({ store, id: first.id })
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "forge"), "conflicting-marker\n"))
      yield* Effect.promise(() => $`git remote remove origin`.cwd(tmp.path).quiet())
      const second = yield* project.resolve(abs(tmp.path))
      const storage = yield* Storage.Service
      const state = yield* storage.get({
        scope: Storage.Scope.make("internal/project-identity"),
        key: Storage.Key.make(store),
      })

      expect(second.id).toBe(first.id)
      expect(state?.value).toBe(first.id)
      expect(state?.revision).toBe(1)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "forge")).text())).toBe(
        "conflicting-marker\n",
      )
    }),
  )

  it.live("does not write either legacy marker while resolving", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "forge")).exists())).toBe(false)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("linked worktree returns opened worktree directory and previous from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-${Date.now()}`.cwd(tmp.path).quiet())
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect(result.previous).toBe(ProjectV2.ID.make("old-id"))
      expect(result.id).toBe(ProjectV2.ID.make("old-id"))
      expect(result.vcs?.type).toBe("git")
    }),
  )
})
