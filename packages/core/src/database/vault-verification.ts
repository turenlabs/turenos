export * as VaultVerification from "./vault-verification"

import { sql, type SQL } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { SecretVault } from "../secret-vault"
import { Database } from "./database"
import { ServerOwner } from "./server-owner"

const PREFIX = "forge-secret:v1:"
const verificationScope = "internal/database-verification"
const verificationKey = "sentinel"

type Sealed = { store: string; scope: string; key: string; value: string }

type Store = {
  name: string
  table: string
  query: SQL
  locate: (row: Record<string, string>) => Array<{ scope: string; key: string; value: string }>
}

// Every table that holds vault envelopes. A store missing from this list is never checked
// before its sealed values are read, so a wrong key could otherwise pass startup.
const stores: Store[] = [
  {
    name: "storage",
    table: "storage_state",
    // `SELECT *` because inspectFile reads unmigrated databases that predate the `deleted` column.
    query: sql`SELECT * FROM storage_state WHERE value LIKE ${PREFIX + "%"}`,
    locate: (row) => (Number(row.deleted ?? 0) ? [] : [{ scope: row.scope!, key: row.key!, value: row.value! }]),
  },
  {
    name: "credential",
    table: "credential",
    // Drizzle JSON mode stores the envelope as a JSON string literal.
    query: sql`SELECT * FROM credential WHERE value LIKE ${'"' + PREFIX + "%"}`,
    locate: (row) => [{ scope: "credential", key: row.id!, value: JSON.parse(row.value!) as string }],
  },
  {
    name: "account",
    table: "account",
    query: sql`SELECT * FROM account`,
    locate: (row) => [
      { scope: `internal/account/${row.id}`, key: "access-token", value: row.access_token! },
      { scope: `internal/account/${row.id}`, key: "refresh-token", value: row.refresh_token! },
    ],
  },
  {
    name: "control-account",
    table: "control_account",
    query: sql`SELECT * FROM control_account`,
    locate: (row) => [
      { scope: `internal/control-account/${row.email}/${row.url}`, key: "access-token", value: row.access_token! },
      { scope: `internal/control-account/${row.email}/${row.url}`, key: "refresh-token", value: row.refresh_token! },
    ],
  },
  {
    name: "session-share",
    table: "session_share",
    query: sql`SELECT * FROM session_share`,
    locate: (row) => [{ scope: "session-share", key: row.id!, value: row.secret! }],
  },
]

export type Report = {
  keyIDs: string[]
  stores: Array<{ store: string; sealed: number; opened: boolean }>
  verification: "missing" | "valid" | "invalid"
}

export function scan(db: Database.Primary) {
  return Effect.gen(function* () {
    const tables = new Set(
      (yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(
        (row) => row.name,
      ),
    )
    const sealed: Sealed[] = []
    for (const store of stores) {
      if (!tables.has(store.table)) continue
      const rows = yield* db.all<Record<string, string>>(store.query)
      for (const row of rows)
        for (const value of store.locate(row))
          if (typeof value.value === "string" && value.value.startsWith(PREFIX))
            sealed.push({ store: store.name, ...value })
    }
    return sealed
  }).pipe(Effect.orDie)
}

/** Reports what the key can open without writing anything. */
export function inspect(db: Database.Primary, databaseUUID: string | undefined, vault: SecretVault.Interface) {
  return Effect.gen(function* () {
    const sealed = yield* scan(db)
    const keyIDs = new Set<string>()
    const counts = new Map<string, number>()
    for (const value of sealed) {
      if (!vault.isSealed(value.value))
        return yield* Effect.die(new Error(`Malformed sealed storage value in store ${value.store} (${value.scope})`))
      keyIDs.add(value.value.slice(PREFIX.length).split(":")[0]!)
      counts.set(value.store, (counts.get(value.store) ?? 0) + 1)
    }
    const opened = new Map<string, boolean>()
    for (const value of sealed) {
      if (value.scope === verificationScope) continue
      const exit = yield* Effect.exit(vault.open(value.scope, value.key, value.value))
      opened.set(value.store, (opened.get(value.store) ?? true) && Exit.isSuccess(exit))
    }
    // Read the row itself: a live sentinel that is not an envelope never reaches `sealed`, and
    // reporting it missing would let a corrupt database pass preflight and then fail every start.
    // `SELECT *` for the same reason as the store query: unmigrated databases lack `deleted`.
    const table = yield* db
      .get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_state'`)
      .pipe(Effect.orDie)
    const row = table
      ? yield* db
          .get<Record<string, string>>(
            sql`SELECT * FROM storage_state WHERE scope = ${verificationScope} AND key = ${verificationKey}`,
          )
          .pipe(Effect.orDie)
      : undefined
    const stored = row && !Number(row.deleted ?? 0) ? { value: row.value! } : undefined
    const verification: Report["verification"] = !stored
      ? "missing"
      : vault.isSealed(stored.value) && (yield* sentinelMatches(vault, stored.value, databaseUUID))
        ? "valid"
        : "invalid"
    return {
      keyIDs: [...keyIDs].sort(),
      stores: [...counts].map(([store, count]) => ({ store, sealed: count, opened: opened.get(store) ?? true })),
      verification,
    } satisfies Report
  })
}

/**
 * Host-side preflight for promotion and restore: opens the database read-only, so it is safe
 * while a quick-connect daemon still runs, and reports what the key can open.
 */
export function inspectFile(filename: string, key: SecretVault.Key) {
  return Effect.gen(function* () {
    const db = yield* Database.openReadonly(filename)
    const identity = yield* databaseUUID(db)
    const owner = yield* ServerOwner.read(db)
    const report = yield* inspect(db, identity, SecretVault.make(key))
    return { ...report, databaseUUID: identity, owner }
  }).pipe(Effect.scoped, Effect.runPromise)
}

export function databaseUUID(db: Database.Primary) {
  return Effect.gen(function* () {
    const table = yield* db.get<{ name: string }>(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_state'
    `)
    if (!table) return undefined
    const identity = yield* db.get<{ value: string }>(sql`
      SELECT value FROM storage_state WHERE scope = 'internal/database' AND key = 'uuid'
    `)
    return identity?.value
  })
}

/**
 * Proves the configured key bytes match this database before any service reads or writes a
 * secret. The first successful start seals a database-bound sentinel; later starts decrypt it.
 */
export function verify(db: Database.Primary, databaseUUID: string, vault: SecretVault.Interface, checked?: Report) {
  return Effect.gen(function* () {
    if (!checked) yield* check(db, databaseUUID, vault)
    if (checked?.verification === "valid") return
    if (!checked && (yield* sentinelValid(db, databaseUUID, vault))) return
    const sealed = yield* vault.seal(verificationScope, verificationKey, plaintext(databaseUUID))
    const now = Date.now()
    yield* db
      .run(
        sql`
        INSERT INTO storage_state (scope, key, value, revision, deleted, time_created, time_updated)
        VALUES (${verificationScope}, ${verificationKey}, ${sealed}, 1, 0, ${now}, ${now})
        ON CONFLICT(scope, key) DO UPDATE SET
          value = excluded.value,
          revision = storage_state.revision + 1,
          deleted = 0,
          time_updated = excluded.time_updated
        WHERE storage_state.deleted = 1
      `,
      )
      .pipe(Effect.orDie)
    if (!(yield* sentinelValid(db, databaseUUID, vault)))
      return yield* Effect.die(
        new Error("Database secret verification failed; the configured key or database is incorrect"),
      )
  })
}

/** Read-only authentication, safe before opening a SQLite write connection or running migrations. */
export function check(db: Database.Primary, databaseUUID: string | undefined, vault: SecretVault.Interface) {
  return Effect.gen(function* () {
    const report = yield* inspect(db, databaseUUID, vault)
    if (report.keyIDs.length > 1)
      return yield* Effect.die(new Error("Database contains secrets sealed by multiple key IDs"))
    if (report.keyIDs.length === 1 && report.keyIDs[0] !== vault.keyID)
      return yield* Effect.die(new Error("Stored credentials belong to another OS-protected key"))
    if (report.verification === "invalid")
      return yield* Effect.die(
        new Error("Database secret verification failed; the configured key or database is incorrect"),
      )
    const failed = report.stores.filter((store) => !store.opened).map((store) => store.store)
    if (failed.length)
      return yield* Effect.die(
        new Error(`Configured key cannot open existing secrets in: ${failed.join(", ")}; the key is incorrect`),
      )
    return report
  })
}

/** Whether the vault opens this database's sentinel, which only key bytes that passed `verify` sealed. */
export function sentinelValid(db: Database.Primary, databaseUUID: string, vault: SecretVault.Interface) {
  return Effect.gen(function* () {
    const stored = yield* db
      .get<{ value: string }>(
        sql`
        SELECT value FROM storage_state
        WHERE scope = ${verificationScope} AND key = ${verificationKey} AND deleted = 0
      `,
      )
      .pipe(Effect.orDie)
    return stored !== undefined && (yield* sentinelMatches(vault, stored.value, databaseUUID))
  })
}

function sentinelMatches(vault: SecretVault.Interface, value: string, databaseUUID: string | undefined) {
  return vault.open(verificationScope, verificationKey, value).pipe(
    Effect.exit,
    Effect.map((exit) => databaseUUID !== undefined && Exit.isSuccess(exit) && exit.value === plaintext(databaseUUID)),
  )
}

function plaintext(databaseUUID: string) {
  return `forge-database-verification:v1:${databaseUUID}`
}
