import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Storage } from "@turenlabs/core/storage"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(filename: string, effect: Effect.Effect<A, E, Storage.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Storage.layer.pipe(Layer.provide(Database.layerFromPath(filename)))), Effect.scoped),
  )

test("independent storage connections observe permission-check changes", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "permission-checks.sqlite")
  await run(filename, PermissionChecks.set(true))
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })

  const observed = run(
    filename,
    Effect.gen(function* () {
      expect(yield* PermissionChecks.enforced()).toBe(true)
      yield* Effect.sync(markStarted)
      while (yield* PermissionChecks.enforced()) yield* Effect.sleep("20 millis")
      return false
    }).pipe(Effect.timeout("2 seconds")),
  )
  await started
  await run(filename, PermissionChecks.set(false))

  expect(await observed).toBe(false)
})
