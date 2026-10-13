import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import SQLite from "bun:sqlite"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

describe("Database reopen", () => {
  test("opens a WAL database whose -shm and -wal files were removed on a clean close", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    const identity = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return (yield* Database.Service).databaseUUID
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )

    const first = await identity()
    // macOS SQLite keeps both side files after the last connection closes; other builds, such as
    // the one an earlier TurenOS release or the sqlite3 CLI uses, delete them. Simulate the latter.
    const writer = new SQLite(filename)
    writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.close()
    rmSync(`${filename}-shm`, { force: true })
    rmSync(`${filename}-wal`, { force: true })

    expect(await identity()).toBe(first)
  })
})
