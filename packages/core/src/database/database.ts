export * as Database from "./database"

import { EffectDrizzleSqlite, isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { layer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { chmod } from "node:fs/promises"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const DEFAULT_READER_POOL_SIZE = 4
const MAX_READER_POOL_SIZE = 8
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/storage/Database") {}

export function primary(db: Interface["db"]) {
  return isWithReplicas(db) ? db.$primary : db
}

export function layerFromPath(filename: string) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const primary = yield* openDatabase({ filename })
      yield* primary.run("PRAGMA journal_mode = WAL")
      yield* primary.run("PRAGMA synchronous = FULL")
      yield* primary.run("PRAGMA secure_delete = ON")
      yield* primary.run("PRAGMA busy_timeout = 5000")
      yield* primary.run("PRAGMA cache_size = -64000")
      yield* primary.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(primary)
      yield* primary.run("PRAGMA wal_checkpoint(PASSIVE)")

      const readers = yield* Effect.forEach(
        Array.from({ length: readerPoolSize(filename) }),
        () =>
          Effect.gen(function* () {
            const reader = yield* openDatabase({ filename, readonly: true, readwrite: false, create: false })
            yield* reader.run("PRAGMA busy_timeout = 5000")
            yield* reader.run("PRAGMA cache_size = -64000")
            yield* reader.run("PRAGMA foreign_keys = ON")
            yield* reader.run("PRAGMA query_only = ON")
            return reader
          }),
        { concurrency: "unbounded" },
      )
      yield* Effect.addFinalizer(() => checkpoint(primary, filename))
      yield* protectDatabaseFiles(filename)
      if (!readers.length) return Service.of({ db: primary })

      const cursor = { value: 0 }
      return Service.of({
        db: EffectDrizzleSqlite.withReplicas(primary, [readers[0], ...readers.slice(1)], (replicas) => {
          const reader = replicas[cursor.value]
          cursor.value = (cursor.value + 1) % replicas.length
          return reader
        }),
      })
    }).pipe(Effect.orDie),
  )
}

function checkpoint(primary: DatabaseShape, filename: string) {
  if (filename === ":memory:") return Effect.void
  return primary.run("PRAGMA busy_timeout = 0").pipe(
    Effect.andThen(
      primary.get<{ busy: number; log: number; checkpointed: number }>(sql`PRAGMA wal_checkpoint(TRUNCATE)`),
    ),
    Effect.flatMap((result) => {
      if (!result || result.busy === 0) return Effect.void
      return Effect.logWarning("SQLite shutdown checkpoint deferred because another connection is active", {
        filename,
        busy: result.busy,
        log: result.log,
        checkpointed: result.checkpointed,
      })
    }),
    Effect.ensuring(primary.run("PRAGMA busy_timeout = 5000").pipe(Effect.orDie)),
    Effect.orDie,
  )
}

function openDatabase(config: Parameters<typeof layer>[0]) {
  return Effect.gen(function* () {
    const context = yield* Layer.build(layer(config))
    return yield* makeDatabase.pipe(Effect.provide(context))
  })
}

function readerPoolSize(filename: string) {
  if (filename === ":memory:") return 0
  const configured = process.env.FORGE_DB_READERS
  if (configured === undefined) return DEFAULT_READER_POOL_SIZE
  const count = Number(configured)
  if (!Number.isSafeInteger(count) || count < 0) return DEFAULT_READER_POOL_SIZE
  return Math.min(count, MAX_READER_POOL_SIZE)
}

function protectDatabaseFiles(filename: string) {
  if (filename === ":memory:" || process.platform === "win32") return Effect.void
  return Effect.promise(() =>
    Promise.all([
      chmod(filename, 0o600),
      ...[`${filename}-wal`, `${filename}-shm`].map((file) =>
        chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return
          throw error
        }),
      ),
    ]),
  ).pipe(Effect.asVoid)
}

export function path() {
  if (Flag.FORGE_DB) {
    if (Flag.FORGE_DB === ":memory:" || isAbsolute(Flag.FORGE_DB)) return Flag.FORGE_DB
    return join(Global.Path.data, Flag.FORGE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.FORGE_DISABLE_CHANNEL_DB === "1" ||
    process.env.FORGE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "forge.db")
  return join(Global.Path.data, `forge-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

// `path()` must be resolved when the layer is built, not when this module is first
// imported. Evaluating it eagerly froze whatever `Flag.FORGE_DB` happened to be at
// import time, so any later reassignment (tests pointing at their own temp database)
// was ignored and the node kept opening a path that had since been deleted.
export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())), deps: [] })
