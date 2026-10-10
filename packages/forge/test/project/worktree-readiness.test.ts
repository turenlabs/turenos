import { afterEach, expect } from "bun:test"
import { chmod, mkdir, rm, symlink } from "node:fs/promises"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Global } from "@turenlabs/core/global"
import { Effect, Fiber, Layer } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, {
        run: Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          if (ctx.project.vcs === "git" && ctx.directory !== ctx.project.worktree)
            yield* Effect.die(new Error("Synthetic bootstrap failure"))
        }),
      }),
    ],
  ]),
)

afterEach(() => disposeAllInstances())

it.instance(
  "records bootstrap failure even when checkout left project files",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const git = yield* Git.Service
      const svc = yield* Worktree.Service
      yield* Effect.promise(() => Bun.write(`${test.directory}/README.md`, "committed project file"))
      yield* git.run(["add", "README.md"], { cwd: test.directory })
      yield* git.run(["commit", "-m", "add file"], { cwd: test.directory })
      const info = yield* svc.create({ name: "bootstrap-failure" })
      const status = yield* pollWithTimeout(
        svc
          .creationStatus("bootstrap-failure")
          .pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "bootstrap failure was not recorded",
      )
      expect(status.directory).toBe(info.directory)
      expect(status.message).toContain("Synthetic bootstrap failure")
      expect(yield* fs.exists(`${info.directory}/README.md`)).toBe(true)
      yield* svc.remove({ directory: info.directory })
      expect(yield* svc.creationStatus("bootstrap-failure")).toEqual({ status: "unknown" })
    }),
  { git: true },
)

it.instance(
  "a worktree under a symlinked path reads unknown after removal",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const git = yield* Git.Service
      const ctx = yield* InstanceState.context
      const svc = yield* Worktree.Service
      yield* Effect.promise(() => Bun.write(`${test.directory}/README.md`, "committed project file"))
      yield* git.run(["add", "README.md"], { cwd: test.directory })
      yield* git.run(["commit", "-m", "add file"], { cwd: test.directory })
      // Worktrees live under Global.Path.data/worktree/<project id>; make that root a symlink.
      const root = `${Global.Path.data}/worktree/${ctx.project.id}`
      yield* Effect.promise(async () => {
        await mkdir(`${Global.Path.data}/worktree`, { recursive: true })
        await mkdir(`${root}-real`, { recursive: true })
        await symlink(`${root}-real`, root)
      })
      const info = yield* svc.create({ name: "linked" })
      expect(info.directory.startsWith(`${root}/`)).toBe(true)
      yield* pollWithTimeout(
        svc.creationStatus("linked").pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "failure was not recorded",
      )
      yield* svc.remove({ directory: info.directory })
      expect(yield* svc.creationStatus("linked")).toEqual({ status: "unknown" })
    }),
  { git: true },
)

it.instance("records setup rejection before any worktree directory exists", () =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    yield* svc.create({ name: "not-git" }).pipe(Effect.exit)
    expect(yield* svc.creationStatus("not-git")).toMatchObject({ status: "failed" })
  }),
)

it.instance(
  "a reused name records a fresh outcome after the previous worktree was removed",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const git = yield* Git.Service
      const svc = yield* Worktree.Service
      yield* Effect.promise(() => Bun.write(`${test.directory}/README.md`, "committed project file"))
      yield* git.run(["add", "README.md"], { cwd: test.directory })
      yield* git.run(["commit", "-m", "add file"], { cwd: test.directory })
      const first = yield* svc.create({ name: "reused" })
      yield* pollWithTimeout(
        svc.creationStatus("reused").pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "first failure was not recorded",
      )
      yield* svc.remove({ directory: first.directory })
      expect(yield* svc.creationStatus("reused")).toEqual({ status: "unknown" })
      const second = yield* svc.create({ name: "reused" })
      const status = yield* pollWithTimeout(
        svc.creationStatus("reused").pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "second attempt was not recorded",
      )
      expect(status.directory).toBe(second.directory)
    }),
  { git: true },
)

it.instance(
  "a failed removal keeps the recorded outcome",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const git = yield* Git.Service
      const svc = yield* Worktree.Service
      yield* Effect.promise(() => Bun.write(`${test.directory}/README.md`, "committed project file"))
      yield* git.run(["add", "README.md"], { cwd: test.directory })
      yield* git.run(["commit", "-m", "add file"], { cwd: test.directory })
      const info = yield* svc.create({ name: "locked" })
      yield* pollWithTimeout(
        svc.creationStatus("locked").pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "failure was not recorded",
      )
      yield* git.run(["worktree", "lock", info.directory], { cwd: test.directory })
      yield* svc.remove({ directory: info.directory }).pipe(Effect.exit)
      expect(yield* svc.creationStatus("locked")).toMatchObject({ status: "failed", directory: info.directory })
    }),
  { git: true },
)

it.instance(
  "an interrupted create settles its entry and frees the name",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const git = yield* Git.Service
      const svc = yield* Worktree.Service
      yield* Effect.promise(() => Bun.write(`${test.directory}/README.md`, "committed project file"))
      yield* git.run(["add", "README.md"], { cwd: test.directory })
      yield* git.run(["commit", "-m", "add file"], { cwd: test.directory })
      // A reference-transaction hook stalls the branch creation in `git worktree add`, so the create is still
      // in flight when interrupted.
      yield* Effect.promise(async () => {
        await Bun.write(`${test.directory}/.git/hooks/reference-transaction`, "#!/bin/sh\nexec sleep 30\n")
        await chmod(`${test.directory}/.git/hooks/reference-transaction`, 0o755)
      })
      const fiber = yield* svc.create({ name: "cancelled" }).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        svc
          .creationStatus("cancelled")
          .pipe(Effect.map((state) => (state.status === "pending" ? state : undefined))),
        "create never started",
      )
      yield* Fiber.interrupt(fiber)
      expect(yield* svc.creationStatus("cancelled")).toEqual({ status: "unknown" })
      yield* Effect.promise(() => rm(`${test.directory}/.git/hooks/reference-transaction`))
      const retry = yield* svc.create({ name: "cancelled" })
      const status = yield* pollWithTimeout(
        svc
          .creationStatus("cancelled")
          .pipe(Effect.map((state) => (state.status === "failed" ? state : undefined))),
        "retry was not recorded",
      )
      expect(status.directory).toBe(retry.directory)
    }),
  { git: true },
)
