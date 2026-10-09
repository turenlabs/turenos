export * as Sqlite from "./sqlite"

import { Context } from "effect"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@turenlabs/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@turenlabs/core/database/SqliteDrizzle") {}

export function exclusiveLock(exec: (sql: string) => unknown, close: () => void) {
  try {
    exec("PRAGMA busy_timeout = 0")
    // Take the lock before any setup write: with no busy timeout, two starters setting the table up
    // first could each fail on the other's write and both report the database as owned. The
    // transaction is never committed, so the table only ever exists inside the held lock.
    exec("BEGIN EXCLUSIVE")
    exec("CREATE TABLE IF NOT EXISTS owner_lock (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)")
    exec("INSERT OR IGNORE INTO owner_lock (id, value) VALUES (1, '')")
    exec("UPDATE owner_lock SET value = value WHERE id = 1")
    return { close }
  } catch (error) {
    close()
    throw error
  }
}
