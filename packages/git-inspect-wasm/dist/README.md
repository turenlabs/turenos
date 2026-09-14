# git-inspect

Bounded, offline, **read-only** WebAssembly inspection of git storage files
for Turen agent tools — loose objects, packfiles, pack indexes, and `DIRC`
index files, without a git binary or a repository checkout.

Input is always **one file's bytes**. There is no repository path, no refs
traversal, no network, and no filesystem access. The module reports structural
facts: it never writes, fetches, or interprets objects beyond the single
supplied buffer.

## Operations

| Function | Signature | Report |
| --- | --- | --- |
| `git_identify` | `(bytes) -> JSON` | Classify: `loose-object`, `pack`, `pack-index` (v1/v2), `index` (DIRC), `bundle`, or `unknown`, with version/counts/checksum facts |
| `git_object_decode` | `(bytes, options) -> JSON` | Inflate a loose object: `{type, size, sha1}` (recomputed to verify integrity), `sizeMatchesDeclared`, trailing-byte count; commit/tag decode tree, parents, author/committer, message; tree lists entries; blob gets a bounded base64 preview + sha256 |
| `git_pack_inspect` | `(bytes, options) -> JSON` | Packfile summary: version, declared vs parsed object count, per-entry `{type, offset, size, compressedSize}` (capped by `maxItems`), ofs-delta/ref-delta counts + max chain depth, trailing SHA-1 verification |
| `git_pack_entry` | `(bytes, options) -> JSON` | Resolve **one** entry selected by `{index}` or `{offset}`: `{type, size, sha1, sha256, chainDepth}` plus a base64 preview bounded by `maxPreviewBytes` (<= 64 KiB) |
| `git_pack_entry_raw` | `(bytes, options) -> bytes` | Same selection, returns the full resolved object as one bounded byte vector (<= 128 MiB); rejects with an error-code string on failure |
| `git_index_inspect` | `(bytes, options) -> JSON` | DIRC v2/v3/v4: version, declared vs parsed entries, entries `{path, sha1, mode, stage, ctime/mtime, dev, ino, uid, gid, size, flags}` capped by `maxItems`, extension names + sizes, trailer checksum |

All JSON operations return `{"schema_version":1,...}` on success and
`{"schema_version":1,"error":"<code>"}` on expected failures; nothing panics
or throws on malformed input. `git_pack_entry_raw` is the "one bounded byte
vector" op: it rejects with the error code string (e.g.
`"delta_depth_exceeded"`) instead of returning error JSON.

## Options

```json
{"maxItems": 4096, "maxPreviewBytes": 8192, "index": 0, "offset": 1234}
```

- `maxItems` (alias `max_items`, 1..4096): caps reported lists.
- `maxPreviewBytes` (alias `max_preview_bytes`, <= 65536): preview cap for
  `git_object_decode`/`git_pack_entry`.
- `index` / `offset`: exactly one is required by `git_pack_entry` /
  `git_pack_entry_raw`; `offset` values come from a prior `git_pack_inspect`
  listing.
- `includeExtensions` (alias `include_extensions`, default true): extension
  table in `git_index_inspect`.

## Formats implemented

Hand-rolled against the documented git formats — no upstream parser code:

- **Loose object**: zlib stream of `"<type> <size>\0" + content`.
- **Packfile** v2/v3: `PACK` header; entries = type/size varint + optional
  delta base (offset varint for `ofs-delta`, 20-byte SHA-1 for `ref-delta`) +
  zlib stream; trailing SHA-1. Delta payload = base-size varint, result-size
  varint, copy/insert opcodes.
- **Pack index** v2: `0xff744f63` magic, 256-entry fanout, sha1/crc32/offset
  tables, large-offset table, two trailing SHA-1s. v1 is recognized by its
  exact-size fanout+record layout.
- **Index** v2/v3/v4: `DIRC` header, stat-cache entries (v3 extended flags;
  v4 prefix-compressed paths), named extensions, trailing SHA-1.
- **Bundle** v1–v3: signature line, `-sha1` prerequisites, `sha1 ref` lines,
  then pack bytes.

`ref-delta` bases are resolved by hashing resolved objects — a companion
`.idx` is not required, and thin packs report `base_not_found` /
`unresolvedBases`.

## Limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| Output JSON | 4 MiB |
| Reported collections (entries, extensions, parents) | 4,096 |
| Content preview | 64 KiB (base64) |
| Extracted object | 128 MiB |
| Delta chain depth (extraction) | 64 |
| Pack entries scanned | 65,536 |
| Aggregate decompression budget per call | 256 MiB |

Limits apply before allocation or serialization. Over-limit lists set
`truncated: true` plus a `warnings` entry; hard failures return error JSON
(`input_too_large`, `options_too_large`, `invalid_options`, `output_too_large`,
`not_pack`, `not_index`, `not_loose_object`, `unsupported_pack_version`,
`unsupported_index_version`, `truncated_input`, `truncated_zlib`,
`zlib_error`, `size_mismatch`, `malformed_header`, `malformed_delta`,
`delta_base_mismatch`, `delta_base_missing`, `base_not_found`,
`delta_depth_exceeded`, `delta_cycle`, `budget_exceeded`, `decompress_limit`,
`missing_selector`, `conflicting_selectors`, `entry_not_found`,
`object_too_large`, `serialization_error`, `internal_error`).

## Build and verify

```sh
cargo test --manifest-path tools/git-inspect/Cargo.toml
wasm-pack build tools/git-inspect --target web --release --out-dir pkg
node tools/git-inspect/script/pack.mjs tools/git-inspect/pkg artifact/git-inspect-wasm
node tools/git-inspect/test/verify.mjs artifact/git-inspect-wasm/dist
cd artifact/git-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

`test/verify.mjs` runs the real compiled module against fixtures fabricated
in pure JS (`node:zlib` deflate + `node:crypto` SHA-1); Rust unit tests
fabricate the same formats independently.

## Provenance

Original implementation by Turen. Runtime dependencies are exact-pinned
crates.io releases committed in `Cargo.lock`: flate2 (pure-Rust miniz_oxide
backend), sha1/sha2 (RustCrypto), serde/serde_json, wasm-bindgen — all
MIT/Apache-2.0. See `SOURCE.json` and `NOTICE`.
