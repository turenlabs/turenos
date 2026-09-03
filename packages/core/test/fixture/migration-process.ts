import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { DatabaseMigration } from "@turenlabs/core/database/migration"

const filename = process.argv[2]
if (!filename) throw new Error("Database filename is required")

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const migration: DatabaseMigration.Migration = {
  id: "test-cross-process-migration-lock",
  up: (tx) =>
    Effect.gen(function* () {
      yield* Effect.sleep("200 millis")
      yield* tx.run(sql`CREATE TABLE cross_process_migration_probe (id integer PRIMARY KEY)`)
    }),
}

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run(sql`PRAGMA busy_timeout = 5000`)
    yield* DatabaseMigration.applyOnly(db, [migration])
  }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
)
