export * as Database from "./database"

import { EffectDrizzleSqlite, isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { acquireExclusiveLock, layer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { basename, dirname, isAbsolute, join, resolve } from "path"
import { chmod, realpath } from "node:fs/promises"
import { existsSync } from "node:fs"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { SecretVault } from "../secret-vault"
import { ServerOwner } from "./server-owner"
import { VaultVerification } from "./vault-verification"

const DEFAULT_READER_POOL_SIZE = 4
const MAX_READER_POOL_SIZE = 8
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>
export type Primary = DatabaseShape
type OwnerContext = ServerOwner.Context & { key?: SecretVault.Key }

export interface Interface {
  db: DatabaseShape
  databaseUUID: string
  /** The key ID this layer verified against every sealed store, when the owner lock carried the key */
  verifiedKeyID?: string
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/storage/Database") {}

export function primary(db: Interface["db"]) {
  return isWithReplicas(db) ? db.$primary : db
}

export function layerFromPath(filename: string) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const ownerContext = yield* Effect.promise(() => currentOwnerContext(filename))
      // Agent tools inherit the service's persistent environment; a `forge` they run must not
      // open, let alone migrate, the live database underneath the server that owns it.
      if (!ownerContext && filename !== ":memory:" && ServerOwner.mode() === "persistent")
        return yield* Effect.die(
          new Error("A persistent server's database opens only inside that server, which holds its owner lock"),
        )
      // The SQLite write connection enables WAL on open. Authenticate an existing file through
      // a read-only connection before that PRAGMA, migrations, or identity/owner writes run.
      const existing = filename !== ":memory:" && existsSync(filename)
      const inspected = existing
        ? yield* Effect.gen(function* () {
            const reader = yield* openReadonly(filename)
            yield* ServerOwner.validate(reader, ownerContext ?? ServerOwner.environmentContext())
            if (!ownerContext?.key) return undefined
            const vault = SecretVault.make(ownerContext.key)
            const databaseUUID = yield* VaultVerification.databaseUUID(reader)
            return yield* VaultVerification.check(reader, databaseUUID, vault)
          }).pipe(Effect.scoped)
        : undefined
      const primary = yield* openDatabase({ filename })
      yield* primary.run("PRAGMA journal_mode = WAL")
      yield* primary.run("PRAGMA synchronous = FULL")
      yield* primary.run("PRAGMA secure_delete = ON")
      yield* primary.run("PRAGMA busy_timeout = 5000")
      yield* primary.run("PRAGMA cache_size = -64000")
      yield* primary.run("PRAGMA foreign_keys = ON")
      if (!existing) yield* ServerOwner.validate(primary, ownerContext ?? ServerOwner.environmentContext())
      yield* DatabaseMigration.apply(primary)
      yield* primary.run(sql`
        INSERT INTO storage_state (scope, key, value, revision, deleted, time_created, time_updated)
        VALUES ('internal/database', 'uuid', ${randomUUID()}, 1, 0, ${Date.now()}, ${Date.now()})
        ON CONFLICT(scope, key) DO NOTHING
      `)
      const databaseIdentity = yield* primary.get<{ value: string }>(sql`
        SELECT value FROM storage_state WHERE scope = 'internal/database' AND key = 'uuid'
      `)
      if (
        !databaseIdentity ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseIdentity.value)
      )
        return yield* Effect.die(new Error("Database identity record is missing or invalid"))
      if (ownerContext?.key) {
        const vault = SecretVault.make(ownerContext.key)
        yield* VaultVerification.verify(primary, databaseIdentity.value, vault, inspected)
        yield* ServerOwner.claim(primary, { ...ownerContext, keyID: vault.keyID })
      }
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
      const verifiedKeyID = ownerContext?.key?.keyID
      if (!readers.length) return Service.of({ db: primary, databaseUUID: databaseIdentity.value, verifiedKeyID })

      const cursor = { value: 0 }
      return Service.of({
        databaseUUID: databaseIdentity.value,
        verifiedKeyID,
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

/** Opens an existing database read-write without migrations, for explicit host-side repairs. */
export function openExisting(filename: string) {
  return openDatabase({ filename, create: false })
}

/** Opens an existing database read-only, without migrations, for host-side inspection. */
export function openReadonly(filename: string) {
  return openDatabase({ filename, readonly: true, readwrite: false, create: false })
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

type OwnerLock = {
  references: number
  context: OwnerContext
  ready: Promise<{ close: () => void }>
}
const ownerLocks = new Map<string, OwnerLock>()

async function ownerLockPath(filename: string) {
  const resolved = await realpath(filename).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return resolve(await realpath(dirname(filename)), basename(filename))
  })
  return { resolved, lockfile: `${resolved}.owner.lock` }
}

async function currentOwnerContext(filename: string) {
  if (filename === ":memory:") return undefined
  const { lockfile } = await ownerLockPath(filename)
  return ownerLocks.get(lockfile)?.context
}

export async function acquireOwnerLock(
  filename: string,
  context: OwnerContext = { mode: "quick-connect", keyID: process.env.FORGE_SECRET_VAULT_KEY_ID },
) {
  if (filename === ":memory:") return () => undefined
  const { resolved, lockfile } = await ownerLockPath(filename)
  const current = ownerLocks.get(lockfile)
  if (
    current &&
    (current.context.mode !== context.mode ||
      current.context.serverID !== context.serverID ||
      current.context.keyID !== context.keyID)
  )
    throw new Error("This process already owns the database with a different server identity")
  if (current && !current.context.key && context.key) current.context.key = context.key
  const entry = current ?? { references: 0, context, ready: Promise.resolve({ close: () => undefined }) }
  if (!current) {
    entry.ready = Promise.resolve().then(() => acquireExclusiveLock(lockfile))
    ownerLocks.set(lockfile, entry)
  }
  entry.references++

  let native: { close: () => void }
  try {
    native = await entry.ready
  } catch (cause) {
    entry.references--
    if (entry.references === 0 && ownerLocks.get(lockfile) === entry) ownerLocks.delete(lockfile)
    if (cause instanceof Error && /database is locked|SQLITE_BUSY/i.test(cause.message))
      throw new Error(`Database is already owned by another server: ${resolved}`, { cause })
    throw cause
  }

  let released = false
  return () => {
    if (released) return
    released = true
    entry.references--
    if (entry.references === 0) {
      ownerLocks.delete(lockfile)
      native.close()
    }
  }
}

// `path()` must be resolved when the layer is built, not when this module is first
// imported. Evaluating it eagerly froze whatever `Flag.FORGE_DB` happened to be at
// import time, so any later reassignment (tests pointing at their own temp database)
// was ignored and the node kept opening a path that had since been deleted.
export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())), deps: [] })
