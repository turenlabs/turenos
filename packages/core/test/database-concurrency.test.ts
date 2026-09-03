import { describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { Database } from "@turenlabs/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const EntryTable = sqliteTable("database_concurrency_entry", {
  id: integer().primaryKey(),
  value: text().notNull(),
})

const run = <A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))

function requirePool(db: Database.Interface["db"]) {
  if (!EffectDrizzleSqlite.isWithReplicas(db)) throw new Error("Expected a file-backed database read pool")
  return db
}

describe("Database read pool", () => {
  test("uses FULL synchronous durability on the primary connection", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "durability.sqlite"),
      Effect.gen(function* () {
        const pool = requirePool((yield* Database.Service).db)
        expect(yield* pool.$primary.get<{ synchronous: number }>(sql`PRAGMA synchronous`)).toEqual({ synchronous: 2 })
      }),
    )
  })

  test("checkpoints committed WAL frames when the managed database scope closes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "checkpoint.sqlite")
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`PRAGMA wal_autocheckpoint = 0`)
        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        yield* db.insert(EntryTable).values({ id: 1, value: "durable" })
        expect((yield* Effect.promise(() => stat(`${filename}-wal`))).size).toBeGreaterThan(0)
      }),
    )

    const wal = await stat(`${filename}-wal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    expect(wal?.size ?? 0).toBe(0)
    await run(
      filename,
      Database.Service.use(({ db }) =>
        db.get<{ value: string }>(sql`SELECT value FROM database_concurrency_entry WHERE id = 1`),
      ).pipe(Effect.map((row) => expect(row).toEqual({ value: "durable" }))),
    )
  })

  test("leaves the WAL recoverable when another process-style reader prevents truncation", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "busy-checkpoint.sqlite")
    const sqlite = await import("bun:sqlite")
    const external = new sqlite.Database(filename)
    const active = { transaction: false }
    try {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          yield* db.run(sql`PRAGMA wal_autocheckpoint = 0`)
          yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
          yield* db.insert(EntryTable).values({ id: 1, value: "before" })
          yield* Effect.sync(() => {
            external.run("BEGIN")
            active.transaction = true
            expect(external.query("SELECT value FROM database_concurrency_entry WHERE id = 1").get()).toEqual({
              value: "before",
            })
          })
          yield* db.insert(EntryTable).values({ id: 2, value: "after" })
        }),
      )

      expect((await stat(`${filename}-wal`)).size).toBeGreaterThan(0)
      expect(external.query("SELECT value FROM database_concurrency_entry ORDER BY id").all()).toEqual([
        { value: "before" },
      ])
    } finally {
      if (active.transaction) external.run("COMMIT")
      external.close()
    }

    await run(
      filename,
      Database.Service.use(({ db }) =>
        db.all<{ value: string }>(sql`SELECT value FROM database_concurrency_entry ORDER BY id`),
      ).pipe(Effect.map((rows) => expect(rows).toEqual([{ value: "before" }, { value: "after" }]))),
    )
  })

  test("opens readers after migrations and exposes committed primary writes", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "visibility.sqlite"),
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const pool = requirePool(db)
        expect(pool.$replicas.length).toBeGreaterThan(1)
        expect(
          yield* pool.$replicas[0].get<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`,
          ),
        ).toEqual({ name: "session" })

        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        yield* db.insert(EntryTable).values({ id: 1, value: "typed" })
        yield* db.run(sql`INSERT INTO database_concurrency_entry (id, value) VALUES (2, 'raw')`)
        yield* db.transaction((tx) => tx.insert(EntryTable).values({ id: 3, value: "transaction" }))

        const cte = db.$with("existing_entries").as(db.select({ id: EntryTable.id }).from(EntryTable))
        yield* db.with(cte).insert(EntryTable).values({ id: 4, value: "cte" })

        const expected = [
          { id: 1, value: "typed" },
          { id: 2, value: "raw" },
          { id: 3, value: "transaction" },
          { id: 4, value: "cte" },
        ]
        const snapshots = yield* Effect.forEach(pool.$replicas, (reader) =>
          reader.select().from(EntryTable).orderBy(EntryTable.id).all(),
        )
        snapshots.forEach((snapshot) => expect(snapshot).toEqual(expected))

        const readerWrite = yield* pool.$replicas[0]
          .insert(EntryTable)
          .values({ id: 5, value: "reader" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(readerWrite)).toBe(true)
      }),
    )
  })

  test("keeps a reader snapshot stable while the writer commits", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "snapshot.sqlite"),
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const pool = requirePool(db)
        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        yield* db.insert(EntryTable).values({ id: 1, value: "before" })

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const reading = yield* pool.$replicas[0]
          .transaction((tx) =>
            Effect.gen(function* () {
              const before = yield* tx.select().from(EntryTable).orderBy(EntryTable.id).all()
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              const after = yield* tx.select().from(EntryTable).orderBy(EntryTable.id).all()
              return { before, after }
            }),
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
        yield* db.insert(EntryTable).values({ id: 2, value: "committed" }).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(reading)).toEqual({
          before: [{ id: 1, value: "before" }],
          after: [{ id: 1, value: "before" }],
        })
        expect(yield* db.select().from(EntryTable).orderBy(EntryTable.id).all()).toEqual([
          { id: 1, value: "before" },
          { id: 2, value: "committed" },
        ])
      }),
    )
  })

  test("runs independent reader sessions concurrently", async () => {
    await using tmp = await tmpdir()
    await run(
      path.join(tmp.path, "sessions.sqlite"),
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const pool = requirePool(db)
        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        yield* db.insert(EntryTable).values({ id: 1, value: "visible" })

        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const session = (index: number, started: Deferred.Deferred<void>) =>
          pool.$replicas[index].transaction((tx) =>
            Effect.gen(function* () {
              const rows = yield* tx.select().from(EntryTable).all()
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return rows
            }),
          )
        const first = yield* session(0, firstStarted).pipe(Effect.forkChild)
        const second = yield* session(1, secondStarted).pipe(Effect.forkChild)

        yield* Effect.all([Deferred.await(firstStarted), Deferred.await(secondStarted)], {
          concurrency: "unbounded",
        }).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(first)).toEqual([{ id: 1, value: "visible" }])
        expect(yield* Fiber.join(second)).toEqual([{ id: 1, value: "visible" }])
      }),
    )
  })

  test("closes the writer and every reader with the layer scope", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "shutdown.sqlite")
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const pool = requirePool(db)
        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        return pool
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )

    expect(Exit.isFailure(await Effect.runPromise(closed.$primary.get(sql`SELECT 1`).pipe(Effect.exit)))).toBe(true)
    for (const reader of closed.$replicas) {
      expect(Exit.isFailure(await Effect.runPromise(reader.get(sql`SELECT 1`).pipe(Effect.exit)))).toBe(true)
    }
    await run(
      filename,
      Database.Service.use(({ db }) =>
        db.get<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_concurrency_entry'`,
        ),
      ).pipe(Effect.map((table) => expect(table).toEqual({ name: "database_concurrency_entry" }))),
    )
  })

  test("uses one connection for an in-memory database", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(EffectDrizzleSqlite.isWithReplicas(db)).toBe(false)
        yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
        yield* db.insert(EntryTable).values({ id: 1, value: "memory" })
        expect(yield* db.select().from(EntryTable).all()).toEqual([{ id: 1, value: "memory" }])
      }),
    )
  })

  if (process.platform !== "win32") {
    test("keeps database and WAL sidecars owner-only", async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "permissions.sqlite")
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          yield* db.run(sql`CREATE TABLE database_concurrency_entry (id integer PRIMARY KEY, value text NOT NULL)`)
          yield* db.insert(EntryTable).values({ id: 1, value: "secret" })
          const modes = yield* Effect.promise(() =>
            Promise.all(
              [filename, `${filename}-wal`, `${filename}-shm`].map((file) => stat(file).then((info) => info.mode)),
            ),
          )
          expect(modes.map((mode) => mode & 0o777)).toEqual([0o600, 0o600, 0o600])
        }),
      )
    })
  }
})
