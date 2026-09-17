// Verifies the real built sqlite-inspect WASM artifact (pkg or packaged dist
// directory) — no mocks. Fixture databases live under test/fixtures/
// (generated once by test/gen-fixtures.sh with the macOS sqlite3 CLI).

import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const fixtures = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fixtures")
const api = await import(pathToFileURL(path.join(directory, "turen_sqlite_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_sqlite_inspect_wasm_bg.wasm")) })

const load = (name) => readFile(path.join(fixtures, name))
const SIMPLE = await load("simple.db")
const WITHOUT_ROWID = await load("without-rowid.db")
const OVERFLOW = await load("overflow.db")
const DELETED = await load("deleted.db")
const CORRUPT = await load("corrupt.db")
const WAL = await load("wal.db")
const UTF16 = await load("utf16.db")
const EMPTY = await load("empty.db")
const MANY = await load("many.db")

const ok = (text) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, undefined, text)
  return value
}
const err = (text, code) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, code, text)
  assert.equal(typeof value.message, "string", text)
}
const OPTIONS = "{}"
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex")

let checks = 0
const check = (fn) => { fn(); checks++ }

// ---- sqlite_inspect ---------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_inspect(SIMPLE, OPTIONS))
  assert.equal(v.kind, "sqlite3")
  assert.equal(v.header.magicOk, true)
  assert.equal(v.header.pageSize, 4096)
  assert.equal(v.header.writeVersion, 1)
  assert.equal(v.header.readVersion, 1)
  assert.equal(v.header.textEncoding.name, "utf-8")
  assert.equal(v.header.userVersion, 7)
  assert.equal(v.header.applicationId, 1337)
  assert.equal(v.header.schemaFormat, 4)
  assert.equal(v.header.autovacuum, false)
  assert.equal(v.journalMode, "rollback")
  assert.equal(v.pages.pagesInFile, 5)
  assert.equal(v.pages.fileSizeIsMultiple, true)
  assert.equal(v.freelist.countMatchesDeclared, true)
})

check(() => {
  const v = ok(api.sqlite_inspect(WAL, OPTIONS))
  assert.equal(v.journalMode, "wal")
  assert.equal(v.header.writeVersion, 2)
  assert.equal(v.header.readVersion, 2)
  const u = ok(api.sqlite_inspect(UTF16, OPTIONS))
  assert.equal(u.header.textEncoding.name, "utf-16le")
})

check(() => {
  const v = ok(api.sqlite_inspect(CORRUPT, OPTIONS))
  assert.equal(v.header.magicOk, false)
  assert.equal(v.header.pageSize, null)
  assert.ok(v.flags.includes("bad_magic"))
  assert.ok(v.flags.includes("bad_page_size"))
})

check(() => {
  err(api.sqlite_inspect(new Uint8Array(0), OPTIONS), "empty_input")
  err(api.sqlite_inspect(new Uint8Array(33 * 1024 * 1024), OPTIONS), "input_too_large")
  err(api.sqlite_inspect(new Uint8Array(50), OPTIONS), "not_sqlite")
  err(api.sqlite_inspect(SIMPLE, "{oops"), "invalid_options")
  err(api.sqlite_inspect(SIMPLE, `{"pad":"${"x".repeat(5000)}"}`), "options_too_large")
})

// ---- sqlite_schema ----------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_schema(SIMPLE, OPTIONS))
  const byName = Object.fromEntries(v.records.map((r) => [r.name, r]))
  assert.equal(byName.users.type, "table")
  assert.equal(byName.meta.type, "table")
  assert.equal(byName.idx_users_age.type, "index")
  assert.equal(byName.idx_users_age.tblName, "users")
  assert.equal(byName.v_users.type, "view")
  assert.equal(byName.v_users.rootpage, 0)
  assert.equal(byName.trg_users.type, "trigger")
  assert.match(byName.users.sql, /CREATE TABLE users/)
  assert.ok(byName.users.rootpage >= 2)
})

check(() => {
  const v = ok(api.sqlite_schema(SIMPLE, "{\"maxItems\":2}"))
  assert.equal(v.records.length, 2)
  assert.equal(v.truncated, true)
  const u = ok(api.sqlite_schema(UTF16, OPTIONS))
  assert.equal(u.records[0].name, "t")
  assert.match(u.records[0].sql, /CREATE TABLE t/)
  err(api.sqlite_schema(CORRUPT, OPTIONS), "invalid_page_size")
})

// ---- sqlite_table_stats ------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_table_stats(SIMPLE, "{\"table\":\"users\"}"))
  const t = v.tables[0]
  assert.equal(t.rows, 4)
  assert.equal(t.depth, 1)
  assert.equal(t.rowid.min, 1)
  assert.equal(t.rowid.max, 4)
  assert.equal(t.pages.leaf, 1)
  assert.equal(t.corrupt, false)
})

check(() => {
  const v = ok(api.sqlite_table_stats(MANY, "{\"table\":\"nums\"}"))
  const t = v.tables[0]
  assert.equal(t.rows, 300)
  assert.ok(t.depth >= 2)
  assert.ok(t.pages.interior >= 1)
  assert.equal(t.rowid.min, 1)
  assert.equal(t.rowid.max, 300)
  const all = ok(api.sqlite_table_stats(SIMPLE, OPTIONS))
  assert.ok(all.tableCount >= 2)
})

check(() => {
  const v = ok(api.sqlite_table_stats(OVERFLOW, "{\"table\":\"big\"}"))
  const t = v.tables[0]
  assert.ok(t.pages.overflow >= 8)
  assert.equal(t.cellsWithOverflow, 3)
  err(api.sqlite_table_stats(SIMPLE, "{\"table\":\"nope\"}"), "table_not_found")
  err(api.sqlite_table_stats(SIMPLE, "{\"table\":\"v_users\"}"), "not_a_table")
})

// ---- sqlite_rows --------------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_rows(SIMPLE, "{\"table\":\"users\",\"maxRows\":256}"))
  assert.equal(v.withoutRowid, false)
  assert.equal(v.rows.length, 4)
  assert.deepEqual(v.rows.map((r) => r.rowid), [1, 2, 3, 4])
  const r1 = v.rows[0].values
  assert.equal(r1[0].type, "null") // INTEGER PRIMARY KEY stores NULL (rowid alias)
  assert.equal(r1[1].value, "alice")
  assert.equal(r1[2].value, 30)
  assert.equal(r1[3].value, 91.5)
  assert.equal(r1[4].type, "blob")
  assert.equal(r1[4].length, 6)
  assert.equal(r1[4].previewHex, "0102deadbeef")
  assert.equal(r1[4].sha256, sha256hex(Buffer.from("0102deadbeef", "hex")))
  assert.equal(v.rows[2].values[3].type, "null")
  assert.equal(v.rows[3].values[2].value, -7)
  assert.equal(v.rows[3].values[4].length, 12)
  assert.equal(v.columnNames[1], "name")
})

check(() => {
  const v = ok(api.sqlite_rows(SIMPLE, "{\"table\":\"users\",\"maxRows\":2}"))
  assert.equal(v.rows.length, 2)
  assert.equal(v.truncated, true)
  // Hard cap: maxRows clamps to 256 even when more is requested.
  const wide = ok(api.sqlite_rows(MANY, "{\"table\":\"nums\",\"maxRows\":9999}"))
  assert.equal(wide.maxRows, 256)
  assert.equal(wide.rows.length, 256)
  assert.equal(wide.truncated, true)
  assert.equal(wide.rows[0].rowid, 1)
  assert.equal(wide.rows[255].rowid, 256)
})

check(() => {
  const v = ok(api.sqlite_rows(WITHOUT_ROWID, "{\"table\":\"dict\",\"maxRows\":10}"))
  assert.equal(v.withoutRowid, true)
  assert.equal(v.rows.length, 3)
  for (const row of v.rows) assert.equal(row.rowid, null)
  // Index b-tree key order.
  assert.deepEqual(v.rows.map((r) => r.values[0].value), ["apple", "mid", "zinc"])
})

check(() => {
  const v = ok(api.sqlite_rows(OVERFLOW, "{\"table\":\"big\",\"maxRows\":10}"))
  assert.equal(v.rows.length, 3)
  const blob = v.rows[0].values[1]
  assert.equal(blob.type, "blob")
  assert.equal(blob.length, 4000)
  assert.equal(blob.sha256, sha256hex(Buffer.alloc(4000)))
  assert.ok(v.rows[0].overflowPages >= 7)
  const text = v.rows[2].values[1]
  assert.equal(text.type, "text")
  assert.equal(text.length, 3000)
  assert.ok(text.value.startsWith("abab"))
  const u = ok(api.sqlite_rows(UTF16, "{\"table\":\"t\",\"maxRows\":10}"))
  assert.equal(u.rows[0].values[0].value, "héllo")
  assert.equal(u.rows[0].values[1].value, 5)
})

check(() => {
  err(api.sqlite_rows(SIMPLE, OPTIONS), "missing_table")
  err(api.sqlite_rows(SIMPLE, "{\"table\":\"nope\"}"), "table_not_found")
  err(api.sqlite_rows(SIMPLE, "{\"table\":\"v_users\"}"), "not_a_table")
  const e = ok(api.sqlite_rows(EMPTY, "{\"table\":\"t\"}"))
  assert.equal(e.rowCount, 0)
})

// ---- sqlite_freelist ------------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_freelist(DELETED, OPTIONS))
  assert.equal(v.declaredFreePages, 6)
  assert.equal(v.countedFreePages, 6)
  assert.equal(v.countMatchesDeclared, true)
  assert.equal(v.broken, false)
  assert.ok(v.trunkCount >= 1)
  assert.equal(v.trunks[0].page, 4)
  assert.ok(v.carving.totalCarvableBytes > 1024)
  const s = ok(api.sqlite_freelist(SIMPLE, OPTIONS))
  assert.equal(s.declaredFreePages, 0)
  assert.equal(s.countedFreePages, 0)
  assert.equal(s.broken, false)
})

check(() => {
  // Cycle: point the trunk at itself.
  const cyclic = Buffer.from(DELETED)
  cyclic.writeUInt32BE(4, 3 * 1024)
  const v = ok(api.sqlite_freelist(cyclic, OPTIONS))
  assert.equal(v.broken, true)
  assert.ok(v.warnings.some((w) => w.includes("cycle")))
  // Out-of-range next pointer.
  const broken = Buffer.from(DELETED)
  broken.writeUInt32BE(9999, 3 * 1024)
  const b = ok(api.sqlite_freelist(broken, OPTIONS))
  assert.equal(b.broken, true)
})

// ---- sqlite_carve ----------------------------------------------------------------

check(() => {
  const v = ok(api.sqlite_carve(DELETED, "{\"maxCandidates\":4096}"))
  assert.equal(v.heuristic, true)
  assert.ok(v.note.length > 0)
  const text = JSON.stringify(v)
  assert.ok(text.includes("scratch-row-111"), "dropped row 1 should carve")
  assert.ok(text.includes("scratch-row-222"), "dropped row 2 should carve")
  for (const c of v.candidates) {
    assert.equal(c.heuristic, true)
    assert.ok(c.confidence > 0 && c.confidence <= 1)
    assert.ok(["unallocated", "freeblock", "freelist-leaf", "freelist-trunk"].includes(c.region))
  }
  // Page numbers stay inside the file.
  for (const c of v.candidates) assert.ok(c.page >= 1 && c.page <= v.scanned.pages)
})

check(() => {
  const v = ok(api.sqlite_carve(DELETED, "{\"maxCandidates\":3}"))
  assert.equal(v.candidates.length, 3)
  assert.equal(v.truncated, true)
  // A freshly written DB with no freelist yields few or no candidates.
  const clean = ok(api.sqlite_carve(EMPTY, OPTIONS))
  assert.equal(clean.heuristic, true)
})

// ---- malformed / fuzz -------------------------------------------------------------

check(() => {
  // Every op must return error JSON or a clean result — never throw, never
  // panic — on random, truncated, and bit-flipped inputs.
  const seeds = [SIMPLE, DELETED, OVERFLOW, WAL, WITHOUT_ROWID, UTF16, MANY, EMPTY]
  const ops = [
    (b) => api.sqlite_inspect(b, OPTIONS),
    (b) => api.sqlite_schema(b, OPTIONS),
    (b) => api.sqlite_table_stats(b, OPTIONS),
    (b) => api.sqlite_rows(b, "{\"table\":\"users\"}"),
    (b) => api.sqlite_freelist(b, OPTIONS),
    (b) => api.sqlite_carve(b, "{\"maxCandidates\":64}"),
  ]
  let runs = 0
  const assertClean = (text) => {
    const v = JSON.parse(text)
    assert.equal(v.schema_version, 1)
    assert.ok(v.error === undefined || typeof v.error === "string")
  }
  // 100 random inputs.
  for (let i = 0; i < 100; i++) {
    const bytes = randomBytes(1 + Math.floor(Math.random() * 8192))
    // Plant the magic sometimes so the fuzzer reaches page parsing.
    if (bytes.length > 100 && i % 3 === 0) bytes.set(Buffer.from("SQLite format 3\0"), 0)
    if (bytes.length > 100 && i % 5 === 0) {
      // Mostly-valid page sizes (512..32768, plus the 1 => 65536 special).
      bytes.writeUInt16BE(i % 4 === 0 ? 1 : 512 * (1 << (i % 7)), 16)
    }
    for (const op of ops) { assertClean(op(bytes)); runs++ }
  }
  // 100 truncations and bit-flips of real fixtures.
  for (let i = 0; i < 100; i++) {
    const base = seeds[i % seeds.length]
    const variant = i % 2 === 0
      ? base.subarray(0, Math.max(1, Math.floor(base.length * Math.random())))
      : (() => {
          const copy = Buffer.from(base)
          for (let f = 0; f < 1 + (i % 7); f++) {
            copy[Math.floor(Math.random() * copy.length)] ^= 1 << (i % 8)
          }
          return copy
        })()
    for (const op of ops) { assertClean(op(variant)); runs++ }
  }
  assert.ok(runs >= 1200, `expected 1200+ fuzz calls, got ${runs}`)
})

check(() => {
  // Determinism.
  assert.equal(api.sqlite_schema(SIMPLE, OPTIONS), api.sqlite_schema(SIMPLE, OPTIONS))
  assert.equal(api.sqlite_freelist(DELETED, OPTIONS), api.sqlite_freelist(DELETED, OPTIONS))
  assert.equal(
    api.sqlite_rows(OVERFLOW, "{\"table\":\"big\"}"),
    api.sqlite_rows(OVERFLOW, "{\"table\":\"big\"}"),
  )
  assert.equal(api.sqlite_carve(DELETED, OPTIONS), api.sqlite_carve(DELETED, OPTIONS))
})

console.log(`sqlite-inspect WASM compatibility verified (${checks} checks)`)
