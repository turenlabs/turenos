# sqlite-inspect

Bounded, offline, **read-only forensic** inspection of SQLite 3 database
files for Turen agent tools — header decode, schema walk, per-table b-tree
statistics, row decoding, freelist analysis, and heuristic record carving,
without a SQLite library or a C dependency.

Input is always **one database file's bytes**. There is no filesystem access,
no journal or `-wal`/`-shm` sidecar, and the buffer is never modified. The
module reports structural facts: it never replays WAL contents, never
recovers the schema into a queryable engine, and never executes SQL.

## Operations

All functions take `(bytes, options_json) -> JSON string`. Success returns
`{"schema_version":1,...}`; expected failures return
`{"schema_version":1,"error":"<code>","message":"..."}`. Nothing panics or
throws on malformed input — corruption is reported in the output.

| Function | Report |
| --- | --- |
| `sqlite_inspect` | 100-byte header decode: magic check, page size, file-format write/read versions (journal mode: `rollback` vs `wal`), payload fractions, file change counter, in-header db size (+`inHeaderSizeValid` when the change counter matches version-valid-for), freelist summary (declared vs chain-counted), schema cookie/format, autovacuum largest-root page, incremental-vacuum flag, text encoding, user version, application id, sqlite version number, and a `flags` array of validity findings (`bad_magic`, `bad_page_size`, `bad_payload_fractions`, `db_size_mismatch`, `trailing_partial_page`, `short_first_page`, `reserved_space_too_large`, `reserved_tail_nonzero`, `unknown_text_encoding`, `unusual_schema_format`) |
| `sqlite_schema` | Walks the sqlite_master b-tree rooted at page 1 (its b-tree header sits at offset 100): every schema record → `{type, name, tblName, rootpage, sql, partialDecode}` with `sql` bounded to 8 KiB |
| `sqlite_table_stats` | Per-table b-tree walk: page counts `{total, interior, leaf, overflow}`, row count, depth, `{min,max}` rowid, cells with overflow, fragmented free bytes, corrupt cells/pages, cycles, broken child pointers. Option `{"table":"name"}` selects one table |
| `sqlite_rows` | Decodes rows of the named table's root b-tree in key order: `{rowid, page, values[], overflowPages, payloadTruncated}`. Values are type-tagged: `{type:"null"}`, `{type:"integer",value}`, `{type:"real",value}`, `{type:"text",value,length,lossless}`, `{type:"blob",length,sha256,previewHex}`. Rowid tables emit `rowid`; WITHOUT ROWID tables (index b-tree root) set `withoutRowid:true` and decode PK-first records with `rowid:null`. `columnNames` is a best-effort parse of the CREATE TABLE column list |
| `sqlite_freelist` | Freelist trunk chain walk: each `{page, nextTrunk, declaredLeafCount, leafPages[]}`, declared vs counted free pages, `broken` flag for cycles/out-of-range links, `invalidLeafPages`, and `carving` stats — bytes available on free pages (leaf bodies + unused trunk tails) |
| `sqlite_carve` | **Heuristic** scan of unallocated gaps, freeblock bodies, and freelist pages for record-shaped data → `{page, pageOffset, fileOffset, region, headerLength, columns, recordBytes, extendsBeyondRegion, confidence, serialTypes, values, valuesDecoded}` per candidate |

## Options

```json
{"maxItems":4096, "table":"users", "maxRows":256,
 "blobPreviewBytes":64, "maxCandidates":512, "minColumns":2}
```

- `maxItems` (≤ 4096): caps reported lists in `sqlite_schema` /
  `sqlite_table_stats` / `sqlite_freelist`.
- `table` (required by `sqlite_rows`, optional for `sqlite_table_stats`).
- `maxRows` (≤ 256, default 64): `sqlite_rows` hard cap.
- `blobPreviewBytes` / `includeBlobsPreview` (≤ 256, default 32): hex preview
  bytes per blob. Full blob bodies are **never** inlined — only length,
  sha256, and the bounded preview.
- `maxCandidates` (≤ 4096, default 256), `minColumns` (1–64, default 2),
  `includeValues` (default true): `sqlite_carve` tuning.
- `includeLeaves` (default true): `sqlite_freelist` emits leaf page lists.

## Format coverage

Hand-rolled against the public-domain SQLite file-format spec — no upstream
parser code:

- **Header**: all 100 bytes including the reserved-tail zero check and the
  change-counter/version-valid-for pairing that gates the in-header db size.
- **B-tree pages**: interior/leaf table (5/13) and index (2/10) pages, cell
  pointer arrays, right-most pointers, freeblock chains, fragmented-byte
  accounting. Page 1's 100-byte offset is handled everywhere.
- **Cells**: payload-size + rowid varints, the `X/M/K` local-payload split
  (table leaf `X=U-35`, index `X=((U-12)*64/255)-23`, `M=((U-12)*32/255)-23`),
  and 4-byte first-overflow pointers with bounded chain walks.
- **Records**: header-length varint, serial types 0–9 (incl. schema-format-4
  constants 0/1 and 24/48-bit sign extension), reserved 10/11 rejected, and
  `N>=12` blob / `N>=13` text sizes. Text is transcoded from UTF-8,
  UTF-16le, or UTF-16be; invalid sequences degrade to U+FFFD with a
  `lossless:false` marker.
- **Freelist**: trunk chain `[next][count][leaf pointers]` with capacity
  checks, cycle detection, and out-of-range leaf reporting.

## Forensic caveats

- **WAL contents are never replayed.** In WAL mode (`journalMode:"wal"`) the
  main file may be behind the `-wal` sidecar; reported rows/pages reflect
  the last checkpointed state only.
- **`sqlite_carve` is heuristic.** A candidate is record-*shaped* data in
  free space — confidence is a scoring hint, not verification. Deleted-row
  bytes whose leading varints were overwritten by freeblock headers may only
  surface as partial candidates (`extendsBeyondRegion`, lower confidence).
- Rowids beyond ±2^53 round-trip as JSON integers that JavaScript consumers
  will see as f64-rounded values.
- `columnNames` is a naive CREATE TABLE parse and may be `null` or wrong for
  exotic DDL.

## Limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| Output JSON | 4 MiB |
| Reported collections | 4,096 |
| `sqlite_rows` rows | 256 |
| Columns per record | 2,000 |
| Per-cell payload | 8 MiB |
| Overflow pages per cell | 4,096 |
| `sql` per schema record | 8 KiB |
| Text value | 4 KiB (truncated, `lossless:false`) |
| Blob preview | 256 bytes + sha256 |
| Carve candidates | 4,096 |

Limits apply before allocation or serialization. Over-limit lists set
`truncated:true` plus a `warnings` entry. Error codes: `empty_input`,
`input_too_large`, `options_too_large`, `invalid_options`,
`output_too_large`, `not_sqlite`, `invalid_page_size`, `page_out_of_range`,
`table_not_found`, `not_a_table`, `missing_table`, `record_header`,
`reserved_serial_type`, `payload_too_large`, `serialization_error`,
`internal_error`. Every page chain (b-tree children, overflow, freelist,
freeblocks) is cycle-guarded — corruption is reported, never an infinite
loop.

## Build and verify

```sh
cargo test --manifest-path tools/sqlite-inspect/Cargo.toml
wasm-pack build tools/sqlite-inspect --target web --release --out-dir pkg
node tools/sqlite-inspect/script/pack.mjs tools/sqlite-inspect/pkg artifact/sqlite-inspect-wasm
node tools/sqlite-inspect/test/verify.mjs artifact/sqlite-inspect-wasm/dist
cd artifact/sqlite-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

`test/verify.mjs` runs the real compiled module against committed fixture
databases under `test/fixtures/` (generated once by `test/gen-fixtures.sh`
with the macOS `/usr/bin/sqlite3` CLI: simple, WITHOUT ROWID, overflow-chain,
deleted/carvable, WAL-mode, UTF-16le, multi-level b-tree, empty, and a
deliberately corrupted file) plus 1,200+ malformed/truncated/bit-flipped
fuzz calls asserting clean error JSON — never a panic.

## Provenance

Original implementation by Turen. Runtime dependencies are exact-pinned
crates.io releases committed in `Cargo.lock`: sha2 (RustCrypto),
serde/serde_json, wasm-bindgen — all MIT/Apache-2.0. The SQLite file-format
specification is public domain. See `SOURCE.json` and `NOTICE`.
