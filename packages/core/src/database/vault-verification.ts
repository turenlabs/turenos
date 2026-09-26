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
    query: sql`SELECT scope, key, value FROM storage_state WHERE deleted = 0 AND value LIKE ${PREFIX + "%"}`,
    locate: (row) => [{ scope: row.scope!, key: row.key!, value: row.value! }],
  },
  {
    name: "credential",
    table: "credential",
    // Drizzle JSON mode stores the envelope as a JSON string literal.
    query: sql`SELECT id, value FROM credential WHERE value LIKE ${'"' + PREFIX + "%"}`,
    locate: (row) => [{ scope: "credential", key: row.id!, value: JSON.parse(row.value!) as string }],
  },
  {
    name: "account",
    table: "account",
    query: sql`SELECT id, access_token, refresh_token FROM account`,
    locate: (row) => [
      { scope: `internal/account/${row.id}`, key: "access-token", value: row.access_token! },
      { scope: `internal/account/${row.id}`, key: "refresh-token", value: row.refresh_token! },
    ],
  },
  {
    name: "control-account",
    table: "control_account",
    query: sql`SELECT email, url, access_token, refresh_token FROM control_account`,
    locate: (row) => [
      { scope: `internal/control-account/${row.email}/${row.url}`, key: "access-token", value: row.access_token! },
      { scope: `internal/control-account/${row.email}/${row.url}`, key: "refresh-token", value: row.refresh_token! },
    ],
  },
  {
    name: "session-share",
    table: "session_share",
    query: sql`SELECT id, secret FROM session_share WHERE secret LIKE ${PREFIX + "%"}`,
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
    const samples = new Map<string, Sealed>()
    for (const value of sealed) {
      if (!vault.isSealed(value.value))
        return yield* Effect.die(new Error(`Malformed sealed storage value in store ${value.store} (${value.scope})`))
      keyIDs.add(value.value.slice(PREFIX.length).split(":")[0]!)
      counts.set(value.store, (counts.get(value.store) ?? 0) + 1)
      if (value.scope === verificationScope) continue
      const sample = `${value.store}\0${value.scope}`
      if (!samples.has(sample)) samples.set(sample, value)
    }
    const opened = new Map<string, boolean>()
    for (const [id, value] of samples) {
      const store = id.split("\0")[0]!
      const exit = yield* Effect.exit(vault.open(value.scope, value.key, value.value))
      opened.set(store, (opened.get(store) ?? true) && Exit.isSuccess(exit))
    }
    const stored = sealed.find((value) => value.scope === verificationScope && value.key === verificationKey)
    const verification: Report["verification"] = !stored
      ? "missing"
      : (yield* sentinelMatches(vault, stored.value, databaseUUID))
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
    const identity = yield* db
      .get<{ value: string }>(sql`SELECT value FROM storage_state WHERE scope = 'internal/database' AND key = 'uuid'`)
      .pipe(Effect.orElseSucceed(() => undefined))
    const owner = yield* ServerOwner.read(db)
    const report = yield* inspect(db, identity?.value, SecretVault.make(key))
    return { ...report, databaseUUID: identity?.value, owner }
  }).pipe(Effect.scoped, Effect.runPromise)
}

/**
 * Proves the configured key bytes match this database before any service reads or writes a
 * secret. The first successful start seals a database-bound sentinel; later starts decrypt it.
 */
export function verify(db: Database.Primary, databaseUUID: string, vault: SecretVault.Interface) {
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
    if (report.verification === "valid") return
    const sealed = yield* vault.seal(verificationScope, verificationKey, plaintext(databaseUUID))
    const now = Date.now()
    yield* db
      .run(
        sql`
        INSERT INTO storage_state (scope, key, value, revision, deleted, time_created, time_updated)
        VALUES (${verificationScope}, ${verificationKey}, ${sealed}, 1, 0, ${now}, ${now})
        ON CONFLICT(scope, key) DO NOTHING
      `,
      )
      .pipe(Effect.orDie)
    const stored = yield* db
      .get<{ value: string }>(
        sql`
        SELECT value FROM storage_state WHERE scope = ${verificationScope} AND key = ${verificationKey}
      `,
      )
      .pipe(Effect.orDie)
    if (!stored || !(yield* sentinelMatches(vault, stored.value, databaseUUID)))
      return yield* Effect.die(
        new Error("Database secret verification failed; the configured key or database is incorrect"),
      )
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
