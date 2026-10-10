import { afterEach, expect } from "bun:test"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Effect, Layer } from "effect"
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
