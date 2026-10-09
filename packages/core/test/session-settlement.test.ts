import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { SessionRunCoordinator } from "@turenlabs/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.effect("terminal failure and a later execution settle independently", () =>
  Effect.gen(function* () {
    const outcomes: string[] = []
    let attempts = 0
    const coordinator = yield* SessionRunCoordinator.make<string, string>({
      drain: () => Effect.suspend(() => (++attempts === 1 ? Effect.fail("terminal") : Effect.void)),
      onSettled: (_key, exit) =>
        Effect.sync(() => {
          outcomes.push(exit._tag)
        }),
    })
    expect(yield* coordinator.run("session").pipe(Effect.flip)).toBe("terminal")
    yield* coordinator.run("session")
    expect(outcomes).toEqual(["Failure", "Success"])
  }),
)

it.effect("observer defects do not strand joins or replace execution outcomes", () =>
  Effect.gen(function* () {
    const coordinator = yield* SessionRunCoordinator.make<string, never>({
      drain: () => Effect.void,
      onSettled: () => Effect.die("observer unavailable"),
    })
    yield* coordinator.run("session")
    expect((yield* coordinator.active).size).toBe(0)
    yield* coordinator.run("session")
  }),
)

it.effect("settles once after coalesced drains, not at intermediate boundaries", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const outcomes: string[] = []
    let turns = 0
    const coordinator = yield* SessionRunCoordinator.make<string, never>({
      drain: () =>
        Effect.gen(function* () {
          turns++
          if (turns === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
        }),
      onSettled: (_key, exit) =>
        Effect.sync(() => {
          outcomes.push(exit._tag)
        }),
    })
    const joined = yield* coordinator.claim("session")
    yield* Deferred.await(started)
    yield* coordinator.wake("session")
    expect(outcomes).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* joined
    expect(turns).toBe(2)
    expect(outcomes).toEqual(["Success"])
  }),
)
