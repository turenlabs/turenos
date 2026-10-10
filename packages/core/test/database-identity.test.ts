import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Database } from "@turenlabs/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

describe("Database identity", () => {
  test("persists one UUID across layer rebuilds and gives each database a distinct UUID", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    const identity = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return (yield* Database.Service).databaseUUID
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )

    const first = await identity()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(await identity()).toBe(first)

    const other = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* Database.Service).databaseUUID
      }).pipe(Effect.provide(Database.layerFromPath(`${tmp.path}/other.db`)), Effect.scoped),
    )
    expect(other).not.toBe(first)
  })
})
