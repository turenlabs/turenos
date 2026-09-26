export * as ServerOwner from "./server-owner"

import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "./database"

export const Mode = Schema.Union([Schema.Literal("quick-connect"), Schema.Literal("persistent")])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Record = Schema.Struct({
  serverID: Schema.String,
  keyID: Schema.String,
  mode: Mode,
  pid: Schema.Number,
  startedAt: Schema.Number,
})
export type Record = Schema.Schema.Type<typeof Record>

export type Context = {
  mode: Mode
  serverID?: string
  keyID?: string
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Record))
const scope = "internal/server-owner"
const key = "record"
const startedAt = Date.now()

export function mode(env: NodeJS.ProcessEnv = process.env): Mode {
  const value = env.FORGE_SERVER_MODE
  if (value === undefined || value === "quick-connect") return "quick-connect"
  if (value === "persistent") return "persistent"
  throw new Error(`unsupported server mode: ${value}`)
}

export function environmentContext(env: NodeJS.ProcessEnv = process.env): Context {
  const current = mode(env)
  return { mode: current, serverID: current === "persistent" ? env.FORGE_SERVER_ID : undefined }
}

export function read(db: Database.Primary) {
  return Effect.gen(function* () {
    const table = yield* db.get<{ name: string }>(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_state'
    `)
    if (!table) return undefined
    // This runs before migrations, so the table may predate its `deleted` column.
    const tombstones = yield* db.get<{ name: string }>(sql`
      SELECT name FROM pragma_table_info('storage_state') WHERE name = 'deleted'
    `)
    const stored = yield* db.get<{ value: string }>(sql`
      SELECT value FROM storage_state WHERE scope = ${scope} AND key = ${key} ${tombstones ? sql`AND deleted = 0` : sql``}
    `)
    if (!stored) return undefined
    const decoded = decode(stored.value)
    if (Option.isNone(decoded)) return yield* Effect.die(new Error("Database server owner record is malformed"))
    return decoded.value
  }).pipe(Effect.orDie)
}

export function validate(db: Database.Primary, context: Context) {
  return Effect.gen(function* () {
    if (context.mode === "persistent" && !context.serverID)
      return yield* Effect.die(new Error("persistent server requires a stable FORGE_SERVER_ID"))
    const owner = yield* read(db)
    if (!owner) return undefined
    if (owner.mode === "persistent") {
      if (
        context.mode !== "persistent" ||
        context.serverID !== owner.serverID ||
        (context.keyID !== undefined && context.keyID !== owner.keyID)
      )
        return yield* Effect.die(new Error("Database is owned by another persistent server"))
      return owner
    }
    if (context.mode === "persistent")
      return yield* Effect.die(new Error("Quick-connect database requires explicit promotion before persistent use"))
    if (context.keyID !== undefined && context.keyID !== owner.keyID)
      return yield* Effect.die(new Error("Database is owned by another quick-connect key"))
    return owner
  })
}

export function claim(db: Database.Primary, context: Context & { keyID: string }) {
  return Effect.gen(function* () {
    const previous = yield* validate(db, context)
    return yield* write(db, {
      serverID: context.mode === "persistent" ? context.serverID! : (previous?.serverID ?? randomUUID()),
      keyID: context.keyID,
      mode: context.mode,
      pid: process.pid,
      startedAt,
    })
  })
}

/** Explicit promotion of a stopped quick-connect database to a persistent owner. */
export function promote(db: Database.Primary, input: { serverID: string; keyID: string }) {
  return Effect.gen(function* () {
    const owner = yield* read(db)
    if (owner?.mode === "persistent" && owner.serverID !== input.serverID)
      return yield* Effect.die(new Error(`Database is already owned by persistent server ${owner.serverID}`))
    if (owner && owner.keyID !== input.keyID)
      return yield* Effect.die(new Error(`Database is owned by key ${owner.keyID}, not ${input.keyID}`))
    return yield* write(db, { ...input, mode: "persistent", pid: process.pid, startedAt })
  })
}

function write(db: Database.Primary, record: Record) {
  return Effect.gen(function* () {
    const now = Date.now()
    yield* db
      .run(sql`
        INSERT INTO storage_state (scope, key, value, revision, deleted, time_created, time_updated)
        VALUES (${scope}, ${key}, ${JSON.stringify(record)}, 1, 0, ${now}, ${now})
        ON CONFLICT(scope, key) DO UPDATE SET
          value = excluded.value,
          revision = storage_state.revision + 1,
          deleted = 0,
          time_updated = excluded.time_updated
      `)
      .pipe(Effect.orDie)
    return record
  })
}
