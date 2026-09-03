import { afterEach, expect } from "bun:test"
import path from "node:path"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. Config initialization adds the canonical schema URL, so the test
// bodies can observe bootstrap without reaching into its services directly.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const config = path.join(dir, "forge.json")
  yield* Effect.promise(() => Bun.write(config, "{}"))
  return { directory: dir, config }
})

const initialized = (config: string) =>
  Bun.file(config)
    .text()
    .then((text) => text.includes('"$schema"'))

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(yield* Effect.promise(() => initialized(tmp.config))).toBe(true)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture

    yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

    expect(yield* Effect.promise(() => initialized(tmp.config))).toBe(true)
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(yield* Effect.promise(() => initialized(tmp.config))).toBe(true)
  }),
)
