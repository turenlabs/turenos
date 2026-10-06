// Generate WAL fixtures with native SQLite while the connection stays open.
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const directory = mkdtempSync(path.join(os.tmpdir(), "sqlite-wal-fixtures-"))
try {
  for (const pageSize of [512, 65536]) {
    const file = path.join(directory, `wal-${pageSize}.db`)
    const db = new Database(file, { create: true })
    try {
      db.exec(`PRAGMA page_size=${pageSize}; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;`)
      db.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT)")
      db.exec("INSERT INTO evidence(value) VALUES ('first')")
      db.exec("INSERT INTO evidence(value) VALUES ('second')")
      writeFileSync(new URL(`./fixtures/native-${pageSize}.wal`, import.meta.url), readFileSync(`${file}-wal`))
      console.log(
        `Generated native-${pageSize}.wal with SQLite ${db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version}`,
      )
    } finally {
      db.close()
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
