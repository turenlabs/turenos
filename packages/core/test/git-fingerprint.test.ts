import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { GitFingerprint } from "@turenlabs/core/git-fingerprint"
import { Global } from "@turenlabs/core/global"
import { Location } from "@turenlabs/core/location"
import { AbsolutePath, RelativePath } from "@turenlabs/core/schema"
import { Snapshot } from "@turenlabs/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(GitFingerprint.node))
const platform = GitFingerprint.supportedPlatform()
const darwin = platform ? describe : describe.skip

describe("GitFingerprint admission", () => {
  it.live("is unavailable on unproven platforms", () =>
    Effect.sync(() => {
      expect(GitFingerprint.supportedPlatform("linux", "6.8.0")).toBe(false)
      expect(GitFingerprint.supportedPlatform("win32", "10.0.0")).toBe(false)
      expect(GitFingerprint.supportedPlatform("darwin", "19.6.0")).toBe(false)
      expect(GitFingerprint.supportedPlatform("darwin", "20.1.0")).toBe(true)
    }),
  )

  it.live("validates canonical anchors", () =>
    Effect.sync(() => {
      for (const bad of ["", "/abs", "a//b", "a/", "./a", "a/../b", "a\\b", "a\0b", ".git/config", "x/.GIT/y", "C:/x"])
        expect(GitFingerprint.canonical(bad)).toBe(false)
      for (const good of ["a", "a/b", ":(glob)**", "*", "new\nline", "has space", ".gitignore"])
        expect(GitFingerprint.canonical(good)).toBe(true)
    }),
  )
})

darwin("GitFingerprint", () => {
  it.live("matches Git's own tree and blob IDs and holds no objects", () =>
    withRepo(
      async (repo) => {
        await write(repo, "a.txt", "alpha\n")
        await write(repo, "dir/b.txt", "beta\n")
        await write(repo, "dir/exec.sh", "#!/bin/sh\n")
        await fs.chmod(path.join(repo.worktree, "dir/exec.sh"), 0o755)
        await fs.symlink("a.txt", path.join(repo.worktree, "link"))
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const objects = await_(() => objectFiles(repo.worktree))
          const before = yield* objects
          const result = yield* capture(repo, ["a.txt", "dir", "link", "missing"])
          const value = available(result)
          expect(value.completeness).toEqual({ state: "complete" })
          expect(value.root).toBe(yield* git(repo.worktree, "rev-parse", "HEAD^{tree}"))
          expect(value.head?.tree).toBe(value.root)
          expect(value.anchors).toEqual([
            { state: "entry", mode: "100644", oid: yield* git(repo.worktree, "rev-parse", "HEAD:a.txt") },
            { state: "tree", oid: yield* git(repo.worktree, "rev-parse", "HEAD:dir"), containsSymlink: false },
            { state: "entry", mode: "120000", oid: yield* git(repo.worktree, "rev-parse", "HEAD:link") },
            { state: "absent" },
          ])
          expect(yield* objects).toEqual(before)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
        }),
    ),
  )

  it.live("leaves the user index and object store untouched and sees staged, flagged and ignored edits", () =>
    withRepo(
      async (repo) => {
        await write(repo, ".gitignore", "*.ignore\n")
        await write(repo, "file", "head\n")
        await write(repo, "skip", "head\n")
        await write(repo, "tracked.ignore", "head\n")
        await commitAll(repo, ["-f"])
        await write(repo, "file", "staged\n")
        await run(repo.worktree, "add", "--", "file")
        await run(repo.worktree, "update-index", "--assume-unchanged", "--", "file")
        await run(repo.worktree, "update-index", "--skip-worktree", "--", "skip")
      },
      (repo) =>
        Effect.gen(function* () {
          const index = path.join(repo.worktree, ".git", "index")
          const before = yield* stamp(index)
          const objects = yield* await_(() => objectFiles(repo.worktree))
          const base = available(yield* capture(repo, ["file", "skip", "tracked.ignore"]))
          expect(base.completeness.state).toBe("complete")
          yield* await_(() => write(repo, "file", "worktree edit hidden by assume-unchanged\n"))
          const assumed = available(yield* capture(repo, ["file", "skip", "tracked.ignore"]))
          expect(assumed.root).not.toBe(base.root)
          expect(assumed.anchors[0]).not.toEqual(base.anchors[0])
          yield* await_(() => write(repo, "skip", "edit hidden by skip-worktree\n"))
          const skipped = available(yield* capture(repo, ["skip"]))
          expect(skipped.anchors[0]).not.toEqual(base.anchors[1])
          yield* await_(() => write(repo, "tracked.ignore", "tracked but ignored edit\n"))
          const ignored = available(yield* capture(repo, ["tracked.ignore"]))
          expect(ignored.anchors[0]).not.toEqual(base.anchors[2])
          const settled = available(yield* capture(repo))
          yield* await_(() => write(repo, "untracked.ignore", "ignored untracked\n"))
          expect(available(yield* capture(repo)).root).toBe(settled.root)
          yield* await_(() => write(repo, "untracked.txt", "untracked\n"))
          expect(available(yield* capture(repo)).root).not.toBe(settled.root)
          expect(yield* stamp(index)).toEqual(before)
          expect(yield* await_(() => objectFiles(repo.worktree))).toEqual(objects)
        }),
    ),
  )

  it.live("hashes raw bytes without running filters, hooks, fsmonitor or included config", () =>
    withRepo(
      async (repo) => {
        const attack = path.join(repo.root, "attack.sh")
        const sentinel = path.join(repo.root, "sentinel")
        await fs.writeFile(attack, `#!/bin/sh\necho fired >> '${sentinel}'\ncat\n`, { mode: 0o700 })
        await fs.mkdir(path.join(repo.root, "hooks"))
        for (const hook of ["post-index-change", "pre-commit"])
          await fs.copyFile(attack, path.join(repo.root, "hooks", hook))
        await fs.chmod(path.join(repo.root, "hooks", "post-index-change"), 0o700)
        await write(repo, ".gitattributes", "*.secret filter=attack\ncrlf text eol=lf\n")
        await write(repo, "crlf", "line\r\n")
        await commitAll(repo)
        const included = path.join(repo.root, "included.config")
        await fs.writeFile(
          included,
          `[filter "attack"]\n\tclean = ${attack}\n\tsmudge = ${attack}\n\trequired = true\n[core]\n\thooksPath = ${path.join(repo.root, "hooks")}\n\tfsmonitor = ${attack}\n\tuntrackedCache = true\n`,
        )
        await run(repo.worktree, "config", "include.path", included)
        await write(repo, "canary.secret", "synthetic filter canary\n")
        // Positive control: ordinary Git with this configuration does execute the sentinel.
        await run(repo.worktree, "status", "--porcelain")
        expect(await Bun.file(sentinel).exists()).toBe(true)
        await fs.rm(sentinel)
      },
      (repo) =>
        Effect.gen(function* () {
          const index = yield* stamp(path.join(repo.worktree, ".git", "index"))
          const value = available(yield* capture(repo, ["canary.secret", "crlf"]))
          expect(value.completeness.state).toBe("complete")
          expect(yield* await_(() => Bun.file(path.join(repo.root, "sentinel")).exists())).toBe(false)
          expect(yield* stamp(path.join(repo.worktree, ".git", "index"))).toEqual(index)
          const raw = yield* await_(() =>
            $`git hash-object --no-filters -- canary.secret crlf`.cwd(repo.worktree).env(env(repo)).text(),
          )
          const [secret, crlf] = raw.trim().split("\n")
          expect(value.anchors).toEqual([
            { state: "entry", mode: "100644", oid: secret },
            { state: "entry", mode: "100644", oid: crlf },
          ])
          // Raw CRLF bytes deliberately differ from the normalized committed blob.
          expect(crlf).not.toBe(yield* git(repo.worktree, "rev-parse", "HEAD:crlf"))
        }),
    ),
  )

  it.live("ignores inherited Git controls and the user's home ignore files", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "content\n")
        await commitAll(repo)
        await write(repo, "home-ignored", "only ignored by HOME/XDG configuration\n")
      },
      (repo) =>
        Effect.gen(function* () {
          const base = available(yield* capture(repo, ["home-ignored"]))
          expect(base.anchors[0]?.state).toBe("entry")
          const hostile = path.join(repo.root, "hostile")
          const home = path.join(repo.root, "home")
          yield* await_(async () => {
            await fs.mkdir(path.join(hostile, "objects"), { recursive: true })
            await fs.mkdir(path.join(home, "xdg", "git"), { recursive: true })
            await fs.writeFile(path.join(home, "xdg", "git", "ignore"), "home-ignored\n")
            await fs.writeFile(
              path.join(home, ".gitconfig"),
              `[core]\n\texcludesFile = ${path.join(home, "excludes")}\n`,
            )
            await fs.writeFile(path.join(home, "excludes"), "home-ignored\n")
          })
          const controls = {
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, "xdg"),
            GIT_DIR: hostile,
            GIT_COMMON_DIR: hostile,
            GIT_WORK_TREE: hostile,
            GIT_INDEX_FILE: path.join(hostile, "index"),
            GIT_OBJECT_DIRECTORY: path.join(hostile, "objects"),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(hostile, "objects"),
            GIT_EXEC_PATH: hostile,
            GIT_CONFIG_PARAMETERS: "'core.excludesFile=/dev/null'",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_VALUE_0: hostile,
            GIT_LITERAL_PATHSPECS: "0",
            GIT_GLOB_PATHSPECS: "1",
          }
          const result = yield* withEnv(controls, capture(repo, ["home-ignored"]))
          expect(available(result).root).toBe(base.root)
          expect(available(result).anchors).toEqual(base.anchors)
          expect(available(result).head).toEqual(base.head)
          expect(yield* await_(() => fs.readdir(hostile))).toEqual(["objects"])
          // Positive control: ordinary Git under that HOME does hide the file.
          const plain = yield* await_(() =>
            $`git ls-files --others --exclude-standard`
              .cwd(repo.worktree)
              .env({ PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") })
              .text(),
          )
          expect(plain).not.toContain("home-ignored")
          // Editing a file ignored only by HOME/XDG configuration changes the fingerprint.
          yield* await_(() => write(repo, "home-ignored", "edited\n"))
          const edited = available(yield* withEnv(controls, capture(repo, ["home-ignored"])))
          expect(edited.root).not.toBe(base.root)
        }),
    ),
  )

  it.live("gives every Git child exactly the allowlisted environment", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "content\n")
        await commitAll(repo)
        // A wrapper that records its environment names and argv, then runs the real Git.
        await fs.writeFile(
          path.join(repo.root, "recording-git"),
          `#!/bin/sh\n{ printf 'ARGS'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; /usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort | /usr/bin/tr '\\n' ' '; printf '\\n'; } >> '${path.join(repo.root, "env.log")}'\nexec /usr/bin/git "$@"\n`,
          { mode: 0o700 },
        )
      },
      (repo) =>
        Effect.gen(function* () {
          const controls = {
            GIT_INDEX_FILE: "/nonexistent",
            GIT_DIR: "/nonexistent",
            SECRET_TOKEN: "x",
            LD_PRELOAD: "x",
          }
          const result = yield* withEnv(controls, capture(repo, [], {}, { git: path.join(repo.root, "recording-git") }))
          expect(result.status).toBe("available")
          const log = (yield* await_(() => fs.readFile(path.join(repo.root, "env.log"), "utf8"))).trim().split("\n")
          const environments = log.filter((_, index) => index % 2 === 1)
          const commands = log.filter((_, index) => index % 2 === 0)
          expect(environments.length).toBeGreaterThan(5)
          const allowed = new Set([
            "PATH",
            "HOME",
            "XDG_CONFIG_HOME",
            "LC_ALL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_ATTR_NOSYSTEM",
            "GIT_OPTIONAL_LOCKS",
            "GIT_TERMINAL_PROMPT",
            "GIT_LITERAL_PATHSPECS",
            "GIT_NO_REPLACE_OBJECTS",
            "GIT_NO_LAZY_FETCH",
            "GIT_ALLOW_PROTOCOL",
            "GIT_PROTOCOL_FROM_USER",
            "GIT_DIR",
            "GIT_COMMON_DIR",
            "GIT_WORK_TREE",
            "GIT_CEILING_DIRECTORIES",
            // Set by /bin/sh itself for the wrapper.
            "PWD",
            "SHLVL",
            "_",
            "OLDPWD",
          ])
          for (const line of environments)
            expect(line.split(" ").filter((name) => name && !allowed.has(name))).toEqual([])
          // Only read-only enumeration commands run.
          const verbs = new Set(
            commands.map((line) => line.split(" ").filter((part) => part !== "-c" && !part.includes("="))[1]),
          )
          expect([...verbs].toSorted()).toEqual(["config", "ls-files", "ls-tree", "rev-parse", "version"])
        }),
    ),
  )

  it.live("treats every filename literally and resolves anchors byte-exactly", () =>
    withRepo(
      async (repo) => {
        for (const name of ["*", ":(glob)**", ":!x", "new\nline", "has space", "File", "caf\u00e9"])
          await write(repo, name, `content of ${JSON.stringify(name)}\n`)
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const names = ["*", ":(glob)**", ":!x", "new\nline", "has space"]
          const value = available(yield* capture(repo, [...names, "file", "FILE", "cafe\u0301"]))
          expect(value.completeness.state).toBe("complete")
          for (const [index, name] of names.entries())
            expect(value.anchors[index]).toEqual({
              state: "entry",
              mode: "100644",
              oid: yield* git(repo.worktree, "rev-parse", `HEAD:${name}`),
            })
          // Case and Unicode aliases of a real entry are not that entry, and not proven absent either.
          expect(value.anchors.slice(names.length)).toEqual([
            { state: "unknown", reason: "outside_universe" },
            { state: "unknown", reason: "outside_universe" },
            { state: "unknown", reason: "outside_universe" },
          ])
          yield* await_(() => write(repo, ":!x", "changed\n"))
          const changed = available(yield* capture(repo, names))
          expect(changed.anchors[2]).not.toEqual(value.anchors[2])
          expect(changed.anchors.filter((_, index) => index !== 2)).toEqual(
            value.anchors.slice(0, names.length).filter((_, index) => index !== 2),
          )
        }),
    ),
  )

  it.live("hashes symlinks as link text and never follows them", () =>
    withRepo(
      async (repo) => {
        await fs.mkdir(path.join(repo.root, "outside"))
        await fs.writeFile(path.join(repo.root, "outside", "child"), "outside\n")
        await write(repo, "dir/file", "inside\n")
        await fs.symlink(path.join(repo.root, "outside"), path.join(repo.worktree, "link"))
        await fs.symlink("../link", path.join(repo.worktree, "dir", "nested-link"))
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const anchors = ["link", "link/child", "dir", "dir/file"]
          const base = available(yield* capture(repo, anchors))
          expect(base.completeness.state).toBe("complete")
          expect(base.anchors[0]).toMatchObject({ state: "entry", mode: "120000" })
          expect(base.anchors[1]).toEqual({ state: "unknown", reason: "symlink_parent" })
          expect(base.anchors[2]).toMatchObject({ state: "tree", containsSymlink: true })
          yield* await_(() => fs.writeFile(path.join(repo.root, "outside", "child"), "edited outside\n"))
          const outside = available(yield* capture(repo, anchors))
          expect(outside.root).toBe(base.root)
          expect(outside.readBytes).toBe(base.readBytes)
          yield* await_(async () => {
            await fs.rm(path.join(repo.worktree, "link"))
            await fs.symlink(path.join(repo.root, "elsewhere"), path.join(repo.worktree, "link"))
          })
          const retargeted = available(yield* capture(repo, anchors))
          expect(retargeted.root).not.toBe(base.root)
          expect(retargeted.anchors[0]).not.toEqual(base.anchors[0])
          expect(retargeted.anchors[3]).toEqual(base.anchors[3])
        }),
    ),
  )

  it.live("reports gitlinks, embedded repositories and oversized files as partial", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "content\n")
        await commitAll(repo)
        const head = (await run(repo.worktree, "rev-parse", "HEAD")).trim()
        await run(repo.worktree, "update-index", "--add", "--cacheinfo", `160000,${head},sub`)
        await write(repo, "sub/dirty", "dirty\n")
        await run(path.join(repo.worktree), "init", "-q", "embedded")
        await write(repo, "embedded/child", "nested\n")
        await write(repo, "large", "x".repeat(200))
      },
      (repo) =>
        Effect.gen(function* () {
          const value = available(
            yield* capture(repo, ["sub/dirty", "embedded/child", "large", "file"], { entryBytes: 100 }),
          )
          expect(value.completeness).toEqual({
            state: "partial",
            reasons: ["embedded_repository", "gitlink", "oversized"],
            excluded: 3,
            samples: ["embedded", "large", "sub"],
            omitted: false,
          })
          expect(value.anchors).toEqual([
            { state: "unknown", reason: "excluded" },
            { state: "unknown", reason: "excluded" },
            { state: "unknown", reason: "excluded" },
            { state: "entry", mode: "100644", oid: yield* git(repo.worktree, "rev-parse", "HEAD:file") },
          ])
        }),
    ),
  )

  it.live("returns unavailable for unsupported repository states", () =>
    Effect.gen(function* () {
      const sparse = yield* fixture(async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await run(repo.worktree, "config", "core.sparseCheckout", "true")
      })
      expect(yield* capture(sparse)).toEqual({ status: "unavailable", reason: "sparse_checkout" })
      const unmerged = yield* fixture(async (repo) => {
        await write(repo, "file", "base\n")
        await commitAll(repo)
        await run(repo.worktree, "checkout", "-q", "-b", "other")
        await write(repo, "file", "other\n")
        await commitAll(repo)
        await run(repo.worktree, "checkout", "-q", "-")
        await write(repo, "file", "main\n")
        await commitAll(repo)
        await run(repo.worktree, "merge", "other").catch(() => undefined)
      })
      expect(yield* capture(unmerged)).toEqual({ status: "unavailable", reason: "unmerged" })
      const sha256 = yield* fixture(async (repo) => {
        await fs.rm(path.join(repo.worktree, ".git"), { recursive: true })
        await run(repo.worktree, "init", "-q", "--object-format=sha256")
      })
      expect(yield* capture(sha256)).toEqual({ status: "unavailable", reason: "object_format" })
      const unborn = yield* fixture(async (repo) => {
        await write(repo, "file", "x\n")
      })
      const value = available(yield* capture(unborn))
      expect(value.head).toBeUndefined()
      expect(value.completeness.state).toBe("complete")
    }),
  )

  it.live("refuses missing, relative or outdated Git executables", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await fs.writeFile(path.join(repo.root, "old-git"), "#!/bin/sh\necho 'git version 2.20.1'\n", { mode: 0o700 })
      },
      (repo) =>
        Effect.gen(function* () {
          for (const executable of ["/nonexistent/git", "git", path.join(repo.root, "old-git")])
            expect(yield* capture(repo, [], {}, { git: executable })).toEqual({
              status: "unavailable",
              reason: "git_capability",
            })
        }),
    ),
  )

  it.live("invalidates captures that race with edits, swaps or replacement", () =>
    withRepo(
      async (repo) => {
        await write(repo, "dir/file", "content\n")
        await write(repo, "other", "content\n")
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const seam = (body: () => Promise<void>) => capture(repo, ["dir/file"], {}, { between: await_(body) })
          expect(yield* seam(() => write(repo, "other", "edited between passes\n"))).toEqual({
            status: "unavailable",
            reason: "race",
          })
          expect(yield* seam(() => write(repo, "added", "new entry\n"))).toEqual({
            status: "unavailable",
            reason: "race",
          })
          expect(
            yield* seam(async () => {
              await fs.rm(path.join(repo.worktree, "other"))
              await $`mkfifo ${path.join(repo.worktree, "other")}`.quiet()
            }),
          ).toEqual({ status: "unavailable", reason: "special_file" })
          yield* await_(async () => {
            await fs.rm(path.join(repo.worktree, "other"))
            await write(repo, "other", "content\n")
          })
          expect(
            yield* seam(async () => {
              await fs.rename(path.join(repo.worktree, "dir"), path.join(repo.root, "moved"))
              await fs.symlink(path.join(repo.root, "moved"), path.join(repo.worktree, "dir"))
            }),
          ).toEqual({ status: "unavailable", reason: "race" })
          yield* await_(async () => {
            await fs.rm(path.join(repo.worktree, "dir"))
            await fs.rename(path.join(repo.root, "moved"), path.join(repo.worktree, "dir"))
          })
          expect(
            yield* seam(async () => {
              await fs.rename(repo.worktree, repo.worktree + "-old")
              await fs.cp(repo.worktree + "-old", repo.worktree, { recursive: true })
            }),
          ).toEqual({ status: "unavailable", reason: "identity" })
        }),
    ),
  )

  it.live("refuses a tracked path replaced by a FIFO without blocking", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await write(repo, "pipe", "was a regular file\n")
        await commitAll(repo)
        await fs.rm(path.join(repo.worktree, "pipe"))
        await $`mkfifo ${path.join(repo.worktree, "pipe")}`.quiet()
        // Git does not enumerate untracked FIFOs, so they are outside the universe.
        await $`mkfifo ${path.join(repo.worktree, "untracked-pipe")}`.quiet()
      },
      (repo) =>
        Effect.gen(function* () {
          const started = Date.now()
          expect(yield* capture(repo)).toEqual({ status: "unavailable", reason: "special_file" })
          expect(Date.now() - started).toBeLessThan(5_000)
        }),
    ),
  )

  it.live("enforces entry, read, output, time and lock bounds", () =>
    withRepo(
      async (repo) => {
        for (const index of Array.from({ length: 5 }, (_, index) => index))
          await write(repo, `f${index}`, "x".repeat(100))
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          expect(yield* capture(repo, [], { entries: 3 })).toEqual({ status: "unavailable", reason: "entry_limit" })
          expect(yield* capture(repo, [], { readBytes: 150 })).toEqual({ status: "unavailable", reason: "read_limit" })
          expect(yield* capture(repo, [], { timeoutMs: 300 }, { between: Effect.sleep("5 seconds") })).toEqual({
            status: "unavailable",
            reason: "timeout",
          })
          const holder = yield* Effect.forkChild(capture(repo, [], { timeoutMs: 10_000 }, { between: Effect.never }))
          yield* waitFor(() => fs.readdir(repo.scratch).then((names) => names.length === 1))
          const started = Date.now()
          expect(yield* capture(repo, [], { timeoutMs: 300 })).toEqual({ status: "unavailable", reason: "lock" })
          expect(Date.now() - started).toBeLessThan(2_000)
          yield* Fiber.interrupt(holder)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
        }),
    ),
  )

  it.live("caps enumeration output, not the version or discovery probes", () =>
    withRepo(
      async (repo) => {
        for (const index of Array.from({ length: 200 }, (_, index) => index))
          await write(repo, `dir/file-${String(index).padStart(4, "0")}`, "x\n")
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          // 200 index records are about 11 KiB; every probe's output is far below 4 KiB.
          expect(yield* capture(repo, [], { outputBytes: 4096 })).toEqual({
            status: "unavailable",
            reason: "output_limit",
          })
          expect(available(yield* capture(repo, [], { outputBytes: 64 * 1024 })).completeness.state).toBe("complete")
        }),
    ),
  )

  it.live("interrupts and times out inside a file read loop and cleans up", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await fs.writeFile(path.join(repo.worktree, "large"), Buffer.alloc(8 * 1024 * 1024, 7))
      },
      (repo) =>
        Effect.gen(function* () {
          const large = path.join(repo.worktree, "large")
          const reading = yield* Deferred.make<void>()
          const chunks = { count: 0 }
          // The seam proves the interruption lands between chunks of an active read of `large`.
          const seam = (event: { phase: string; path: string }) =>
            event.phase === "chunk" && event.path === large
              ? Effect.sync(() => chunks.count++).pipe(
                  Effect.andThen(Deferred.succeed(reading, undefined)),
                  Effect.andThen(Effect.sleep("20 millis")),
                )
              : Effect.void
          const fiber = yield* Effect.forkChild(capture(repo, [], {}, { seam }))
          yield* Deferred.await(reading)
          const started = Date.now()
          yield* Fiber.interrupt(fiber)
          expect(Date.now() - started).toBeLessThan(1_000)
          expect(chunks.count).toBeGreaterThan(0)
          expect(chunks.count).toBeLessThan(8 * 16)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
          // Read budget is charged per chunk inside the loop.
          const limited = { count: 0 }
          expect(
            yield* capture(
              repo,
              [],
              { readBytes: 256 * 1024 },
              {
                seam: (event) => (event.phase === "chunk" ? Effect.sync(() => limited.count++) : Effect.void),
              },
            ),
          ).toEqual({ status: "unavailable", reason: "read_limit" })
          expect(limited.count).toBeLessThan(8)
          // The deadline expires while the read loop is running, not in a Git child. Either the
          // in-loop check or the outer interruptible timeout may end it; this proves the deadline
          // holds during an active read, not which of the two mechanisms fired.
          const timedChunks = { count: 0, first: 0 }
          const timed = yield* capture(
            repo,
            [],
            { timeoutMs: 5_000 },
            {
              seam: (event) =>
                event.phase === "chunk" && event.path === large
                  ? Effect.sync(() => {
                      timedChunks.count++
                      if (!timedChunks.first) timedChunks.first = Date.now()
                    }).pipe(Effect.andThen(Effect.sleep("100 millis")))
                  : Effect.void,
            },
          )
          expect(timed).toEqual({ status: "unavailable", reason: "timeout" })
          expect(timedChunks.count).toBeGreaterThan(1)
          expect(timedChunks.count).toBeLessThan(128)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
        }),
    ),
  )

  it.live("refuses swaps between lstat and the protected open without reading outside content", () =>
    withRepo(
      async (repo) => {
        await write(repo, "dir/file", "inside\n")
        await write(repo, "plain", "inside\n")
        await commitAll(repo)
        await fs.mkdir(path.join(repo.root, "outside", "dir"), { recursive: true })
        await fs.writeFile(path.join(repo.root, "outside", "dir", "file"), "OUTSIDE-CANARY\n")
        await fs.writeFile(path.join(repo.root, "outside", "plain"), "OUTSIDE-CANARY\n")
      },
      (repo) =>
        Effect.gen(function* () {
          const outsideOID = yield* await_(() =>
            $`git hash-object --no-filters -- ${path.join(repo.root, "outside", "plain")}`.env(env(repo)).text(),
          )
          const swapOnce = (target: string, swap: () => Promise<void>, reads: { count: number }) => {
            const state = { done: false }
            return (event: { phase: string; path: string }) => {
              // Any chunk read of the swapped path means content was read before refusal.
              if (event.phase === "chunk" && event.path === target && state.done)
                return Effect.sync(() => reads.count++)
              return event.phase === "open" && event.path === target && !state.done
                ? Effect.promise(async () => {
                    state.done = true
                    await swap()
                  })
                : Effect.void
            }
          }
          const reset = () =>
            Effect.promise(async () => {
              await fs.rm(path.join(repo.worktree, "dir"), { recursive: true, force: true })
              await fs.rm(path.join(repo.worktree, "plain"), { recursive: true, force: true })
              await write(repo, "dir/file", "inside\n")
              await write(repo, "plain", "inside\n")
            })
          const cases: [string, string, () => Promise<void>, GitFingerprint.UnavailableReason][] = [
            [
              "final symlink",
              path.join(repo.worktree, "plain"),
              async () => {
                await fs.rm(path.join(repo.worktree, "plain"))
                await fs.symlink(path.join(repo.root, "outside", "plain"), path.join(repo.worktree, "plain"))
              },
              "race",
            ],
            [
              "intermediate directory to symlink",
              path.join(repo.worktree, "dir", "file"),
              async () => {
                await fs.rename(path.join(repo.worktree, "dir"), path.join(repo.root, "moved"))
                await fs.symlink(path.join(repo.root, "outside", "dir"), path.join(repo.worktree, "dir"))
              },
              "race",
            ],
            [
              "regular file to FIFO",
              path.join(repo.worktree, "plain"),
              async () => {
                await fs.rm(path.join(repo.worktree, "plain"))
                await $`mkfifo ${path.join(repo.worktree, "plain")}`.quiet()
              },
              "race",
            ],
            [
              "replacement by another regular file",
              path.join(repo.worktree, "plain"),
              async () => {
                await fs.rm(path.join(repo.worktree, "plain"))
                // Same size, so only the descriptor identity check can refuse it.
                await fs.writeFile(path.join(repo.worktree, "plain"), "CANARY\n")
              },
              "race",
            ],
          ]
          for (const [name, target, swap, reason] of cases) {
            const started = Date.now()
            const reads = { count: 0 }
            const result = yield* capture(repo, ["plain", "dir/file"], {}, { seam: swapOnce(target, swap, reads) })
            expect({ name, result }).toEqual({ name, result: { status: "unavailable", reason } })
            expect({ name, reads: reads.count }).toEqual({ name, reads: 0 })
            expect(JSON.stringify(result)).not.toContain(outsideOID.trim())
            expect(Date.now() - started).toBeLessThan(5_000)
            yield* await_(() => fs.rm(path.join(repo.root, "moved"), { recursive: true, force: true }))
            yield* reset()
          }
        }),
    ),
  )

  it.live("detects ignore-source edits between passes", () =>
    withRepo(
      async (repo) => {
        await write(repo, ".gitignore", "a\n")
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await fs.writeFile(path.join(repo.root, "local-excludes"), "b\n")
        await run(repo.worktree, "config", "core.excludesFile", path.join(repo.root, "local-excludes"))
      },
      (repo) =>
        Effect.gen(function* () {
          const edits: [string, () => Promise<void>][] = [
            [".gitignore", () => write(repo, ".gitignore", "a\nc\n")],
            ["info/exclude", () => fs.appendFile(path.join(repo.worktree, ".git", "info", "exclude"), "d\n")],
            ["core.excludesFile", () => fs.appendFile(path.join(repo.root, "local-excludes"), "e\n")],
          ]
          for (const [name, edit] of edits) {
            const result = yield* capture(repo, [], {}, { between: await_(edit) })
            expect({ name, result }).toEqual({ name, result: { status: "unavailable", reason: "race" } })
          }
        }),
    ),
  )

  it.live("matches Git's tree ID for names that sort around the directory separator and multibyte names", () =>
    withRepo(
      async (repo) => {
        for (const name of ["a-b", "a.b", "a/c", "a0", "a", "\u00e9t\u00e9", "\u65e5\u672c/x", "Z", "_"].filter(
          (name) => name !== "a",
        ))
          await write(repo, name, `${name}\n`)
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const value = available(yield* capture(repo))
          expect(value.completeness.state).toBe("complete")
          expect(value.root).toBe(yield* git(repo.worktree, "rev-parse", "HEAD^{tree}"))
        }),
    ),
  )

  it.live("excludes case-only aliases of one file on a case-insensitive filesystem", () =>
    withRepo(
      async (repo) => {
        await write(repo, "Readme.md", "x\n")
        await commitAll(repo)
        // Track a second, case-variant path that resolves to the same file.
        const blob = (await run(repo.worktree, "hash-object", "-w", "Readme.md")).trim()
        await run(repo.worktree, "update-index", "--add", "--cacheinfo", `100644,${blob},README.md`)
      },
      (repo) =>
        Effect.gen(function* () {
          const caseSensitive = yield* await_(() =>
            fs.stat(path.join(repo.worktree, "README.md")).then(
              () => false,
              () => true,
            ),
          )
          if (caseSensitive) return
          const value = available(yield* capture(repo))
          expect(value.completeness).toMatchObject({ state: "partial", reasons: ["alias"], excluded: 2 })
        }),
    ),
  )

  it.live("observes repository ignore sources and reports unreadable files as partial", () =>
    withRepo(
      async (repo) => {
        await write(repo, ".gitignore", "dir-ignored\n")
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await fs.writeFile(path.join(repo.worktree, ".git", "info", "exclude"), "info-ignored\n")
        await fs.writeFile(path.join(repo.root, "local-excludes"), "local-ignored\n")
        await run(repo.worktree, "config", "core.excludesFile", path.join(repo.root, "local-excludes"))
        for (const name of ["dir-ignored", "info-ignored", "local-ignored"]) await write(repo, name, "ignored\n")
        await write(repo, "denied", "unreadable\n")
        await fs.chmod(path.join(repo.worktree, "denied"), 0)
      },
      (repo) =>
        Effect.gen(function* () {
          const value = available(yield* capture(repo, ["dir-ignored", "info-ignored", "local-ignored", "denied"]))
          expect(value.anchors.slice(0, 3)).toEqual(Array(3).fill({ state: "unknown", reason: "outside_universe" }))
          expect(value.anchors[3]).toEqual({ state: "unknown", reason: "excluded" })
          expect(value.completeness).toEqual({
            state: "partial",
            reasons: ["unreadable"],
            excluded: 1,
            samples: ["denied"],
            omitted: false,
          })
          yield* await_(() => fs.chmod(path.join(repo.worktree, "denied"), 0o600))
        }),
    ),
  )

  it.live("never reports complete when Git cannot enumerate an untracked directory", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        for (const [name, mode] of [
          ["closed", 0o000],
          ["write-exec", 0o300],
        ] as const) {
          await write(repo, `${name}/hidden`, "untracked content\n")
          await fs.chmod(path.join(repo.worktree, name), mode)
        }
      },
      (repo) =>
        Effect.gen(function* () {
          const result = yield* capture(repo)
          yield* await_(async () => {
            for (const name of ["closed", "write-exec"]) await fs.chmod(path.join(repo.worktree, name), 0o700)
          })
          expect(result).toEqual({ status: "unavailable", reason: "io" })
        }),
    ),
  )

  it.live("kills an in-flight Git child on interruption and timeout", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await fs.writeFile(
          path.join(repo.root, "slow-git"),
          `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--others" ]; then echo $$ > '${path.join(repo.root, "pid")}'; exec sleep 30; fi; done\nexec /usr/bin/git "$@"\n`,
          { mode: 0o700 },
        )
      },
      (repo) =>
        Effect.gen(function* () {
          const pidFile = path.join(repo.root, "pid")
          const slow = { git: path.join(repo.root, "slow-git") }
          const fiber = yield* Effect.forkChild(capture(repo, [], {}, slow))
          yield* waitFor(() => Bun.file(pidFile).exists())
          const pid = Number(yield* await_(() => fs.readFile(pidFile, "utf8")))
          expect(alive(pid)).toBe(true)
          yield* Fiber.interrupt(fiber)
          yield* waitFor(async () => !alive(pid))
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
          yield* await_(() => fs.rm(pidFile))
          const started = Date.now()
          expect(yield* capture(repo, [], { timeoutMs: 1_000 }, slow)).toEqual({
            status: "unavailable",
            reason: "timeout",
          })
          expect(Date.now() - started).toBeLessThan(3_000)
          const second = Number(yield* await_(() => fs.readFile(pidFile, "utf8")))
          yield* waitFor(async () => !alive(second))
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
        }),
    ),
  )

  it.live("keeps no file content in scratch and produces stable IDs after scratch deletion", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await write(repo, "credential-canary", "SYNTHETIC-NEVER-A-REAL-CREDENTIAL-5d1f\n")
      },
      (repo) =>
        Effect.gen(function* () {
          const files: string[] = []
          const first = available(
            yield* capture(
              repo,
              ["credential-canary"],
              {},
              {
                between: await_(async () => {
                  for (const entry of await fs.readdir(repo.scratch, { recursive: true, withFileTypes: true }))
                    if (entry.isFile()) files.push(await fs.readFile(path.join(entry.parentPath, entry.name), "utf8"))
                }),
              },
            ),
          )
          expect(files.join("")).not.toContain("SYNTHETIC-NEVER")
          expect(JSON.stringify(first)).not.toContain("SYNTHETIC-NEVER")
          yield* await_(() => fs.rm(repo.scratch, { recursive: true, force: true }))
          const second = available(yield* capture(repo, ["credential-canary"]))
          expect(second.root).toBe(first.root)
          expect(second.anchors).toEqual(first.anchors)
          for (const _ of Array.from({ length: 5 })) yield* capture(repo)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([])
        }),
    ),
  )

  it.live("gives equal linked worktrees equal fingerprints", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
        await run(repo.worktree, "worktree", "add", "-q", "--detach", path.join(repo.root, "linked"), "HEAD")
      },
      (repo) =>
        Effect.gen(function* () {
          const linked = {
            ...repo,
            worktree: path.join(repo.root, "linked"),
            gitDirectory: path.join(repo.worktree, ".git", "worktrees", "linked"),
          }
          const main = available(yield* capture(repo, ["file"]))
          const other = available(yield* capture(linked, ["file"]))
          expect(other.root).toBe(main.root)
          expect(other.identity.common).toEqual(main.identity.common)
          yield* await_(() => fs.writeFile(path.join(linked.worktree, "file"), "changed\n"))
          expect(available(yield* capture(linked, ["file"])).anchors).not.toEqual(main.anchors)
          // A mismatched Git directory is not the bound repository.
          expect(yield* capture({ ...linked, gitDirectory: path.join(repo.worktree, ".git") })).toEqual({
            status: "unavailable",
            reason: "identity",
          })
        }),
    ),
  )

  it.live("reclaims scratch only from dead owners and bounds scratch directories", () =>
    withRepo(
      async (repo) => {
        await write(repo, "file", "x\n")
        await commitAll(repo)
      },
      (repo) =>
        Effect.gen(function* () {
          const spawn = () =>
            Bun.spawn(
              [process.execPath, path.join(import.meta.dir, "fixture", "fingerprint-worker.ts"), JSON.stringify(repo)],
              {
                stdout: "ignore",
                stderr: "ignore",
              },
            )
          // Two independent processes capture the same worktree concurrently with distinct scratch.
          const workers = [spawn(), spawn()]
          yield* waitFor(() =>
            fs
              .readdir(repo.scratch)
              .then((names) => workers.every((worker) => names.some((name) => name.startsWith(`cap-${worker.pid}-`)))),
          )
          for (const worker of workers) worker.kill("SIGKILL")
          yield* await_(() => Promise.all(workers.map((worker) => worker.exited)))
          expect((yield* await_(() => fs.readdir(repo.scratch))).length).toBe(2)
          const live = path.join(repo.scratch, `cap-${process.ppid}-foreign`)
          yield* await_(() => fs.mkdir(live))
          // The first capture in this process reclaims dead owners automatically, keeping live ones.
          expect(available(yield* capture(repo)).completeness.state).toBe("complete")
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([path.basename(live)])
          const fingerprint = yield* GitFingerprint.Service
          yield* fingerprint.reclaim(repo.scratch)
          expect(yield* await_(() => fs.readdir(repo.scratch))).toEqual([path.basename(live)])
          yield* await_(async () => {
            for (const index of Array.from({ length: 3 }, (_, index) => index))
              await fs.mkdir(path.join(repo.scratch, `cap-${process.ppid}-held-${index}`))
          })
          expect(yield* capture(repo, [], { scratchDirectories: 4 })).toEqual({
            status: "unavailable",
            reason: "scratch_limit",
          })
        }),
    ),
  )
})

darwin("GitFingerprint and Snapshot", () => {
  testEffect(Layer.empty).live("coexist without sharing index or object state", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const repo = repoPaths(tmp.path)
          yield* await_(async () => {
            await init(repo)
            await write(repo, "file", "one\n")
            await commitAll(repo)
          })
          const data = path.join(tmp.path, "data")
          const layer = Layer.merge(
            AppNodeBuilder.build(Snapshot.node, [
              [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(repo.worktree) }))],
              [Global.node, Global.layerWith({ data, config: path.join(tmp.path, "config") })],
            ]),
            LayerNode.compile(GitFingerprint.node),
          )
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const fingerprint = yield* GitFingerprint.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* await_(() => write(repo, "file", "two\n"))
            const shadow = yield* await_(() => listFiles(path.join(data, "snapshot")))
            const state = yield* await_(() => Promise.all(shadow.map((file) => fs.readFile(file))))
            const user = yield* stamp(path.join(repo.worktree, ".git", "index"))
            const result = yield* fingerprint.capture({ repository: repo, scratch: repo.scratch, anchors: ["file"] })
            expect(result.status).toBe("available")
            expect(yield* await_(() => listFiles(path.join(data, "snapshot")))).toEqual(shadow)
            expect(yield* await_(() => Promise.all(shadow.map((file) => fs.readFile(file))))).toEqual(state)
            expect(yield* stamp(path.join(repo.worktree, ".git", "index"))).toEqual(user)
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return
            expect(yield* snapshot.files({ from: before, to: after })).toEqual([RelativePath.make("file")])
            yield* snapshot.restore({ files: new Map([[RelativePath.make("file"), before]]) })
            expect(yield* await_(() => fs.readFile(path.join(repo.worktree, "file"), "utf8"))).toBe("one\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

type Repo = ReturnType<typeof repoPaths>

function repoPaths(root: string) {
  const worktree = path.join(root, "repo")
  return {
    root,
    worktree,
    gitDirectory: path.join(worktree, ".git"),
    commonDirectory: path.join(worktree, ".git"),
    scratch: path.join(root, "scratch"),
  }
}

function withRepo<A, E, R>(setup: (repo: Repo) => Promise<void>, body: (repo: Repo) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const repo = repoPaths(tmp.path)
        yield* await_(async () => {
          await init(repo)
          await setup(repo)
        })
        return yield* body(repo)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

function fixture(setup: (repo: Repo) => Promise<void>) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      const repo = repoPaths(tmp.path)
      await init(repo)
      await setup(repo)
      return { tmp, repo }
    }),
    (value) => Effect.promise(() => value.tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.map((value) => value.repo))
}

function capture(
  repo: Repo,
  anchors: readonly string[] = [],
  limits: Partial<GitFingerprint.Limits> = {},
  extra: Pick<GitFingerprint.Input, "git" | "between" | "seam"> = {},
) {
  return Effect.gen(function* () {
    const fingerprint = yield* GitFingerprint.Service
    return yield* fingerprint.capture({ repository: repo, scratch: repo.scratch, anchors, limits, ...extra })
  })
}

function available(result: GitFingerprint.Result) {
  if (result.status !== "available") throw new Error(`capture unavailable: ${result.reason}`)
  return result
}

function env(repo: Repo) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: repo.root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@forge.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@forge.test",
  }
}

async function run(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: env(repoPaths(path.dirname(cwd))), stdin: "ignore" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function git(cwd: string, ...args: string[]) {
  return await_(() => run(cwd, ...args)).pipe(Effect.map((text) => text.trim()))
}

async function init(repo: Repo) {
  await fs.mkdir(repo.worktree, { recursive: true })
  await run(repo.worktree, "init", "-q", "-b", "main")
  await run(repo.worktree, "config", "core.fsmonitor", "false")
  await run(repo.worktree, "config", "commit.gpgsign", "false")
}

async function write(repo: Repo, name: string, content: string) {
  await fs.mkdir(path.dirname(path.join(repo.worktree, name)), { recursive: true })
  await fs.writeFile(path.join(repo.worktree, name), content)
}

async function commitAll(repo: Repo, add: string[] = []) {
  await run(repo.worktree, "add", "-A", ...add, ".")
  await run(repo.worktree, "commit", "-q", "--allow-empty", "-m", "fixture")
}

async function objectFiles(worktree: string) {
  return (await fs.readdir(path.join(worktree, ".git", "objects"), { recursive: true })).toSorted()
}

async function listFiles(root: string) {
  return (await fs.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted()
}

function stamp(file: string) {
  return await_(async () => {
    const stats = await fs.lstat(file, { bigint: true })
    return {
      bytes: Buffer.from(await fs.readFile(file)).toString("base64"),
      meta: [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].map(String),
    }
  })
}

function withEnv<A, E, R>(values: Record<string, string>, effect: Effect.Effect<A, E, R>) {
  // The capture's own children must not inherit these; setting them on the server process is the threat.
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      Object.assign(process.env, values)
      return saved
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitFor(check: () => Promise<boolean>) {
  return Effect.promise(async () => {
    const deadline = Date.now() + 10_000
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) throw new Error("condition not reached")
      await Bun.sleep(10)
    }
  })
}

function await_<A>(body: () => Promise<A>) {
  return Effect.promise(body)
}
