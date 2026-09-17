# Browser forensic artifact parser for Turen

Bounded WebAssembly agent tool. Offline bytes only — no filesystem, network,
process, or environment access; the browser counterpart to
`tools/windows-artifacts` and `tools/macos-artifacts`. Every parser is an
original bounded implementation of a documented on-disk format.

## Operations

Every operation has the signature `(bytes: &[u8], options_json: &str) -> String`
and returns deterministic JSON. Expected failures return
`{"schema_version":1,"error":"<code>"}`. Successful parses return
`{"schema_version":1,"format":"<kind>","truncated":bool,"warnings":[],"result":{...}}`.

- `leveldb_log_parse` — one Chromium LevelDB write log (`.log`, the format
  behind Local Storage, Session Storage, and IndexedDB journals). Records
  are framed in 32 KiB blocks as FULL/FIRST/MIDDLE/LAST physical records
  with a masked CRC-32C verified per record (option `verify_crc`, default
  true), reassembled into logical records, and decoded as WriteBatch
  batches. Each emitted record is one batch entry:
  `{index, log_offset, batch_sequence, sequence, operation, key, value}`
  where `operation` is `"put"`, `"delete"` (deleted-record recovery is the
  forensic point), or `"unparsed"` for logical records that are not valid
  WriteBatches (e.g. MANIFEST VersionEdits). Keys and values are bounded
  previews `{length, utf8, utf8_valid, hex, sha256}`. Options:
  `max_results` (<=4096, default 256), `verify_crc` (default true).
- `leveldb_table_parse` — one Chromium LevelDB table (`.ldb`/`.sst`):
  the 48-byte footer (metaindex + index block handles, magic
  `0xdb4775248b80fb57`), the index block's BlockHandle entries, and each
  data block decoded with shared-prefix entry decompression. Snappy
  (`snap`, raw format) blocks are decompressed with the declared length
  checked against a 64 MiB cap before allocation; block CRC-32C is
  verified when `verify_crc` is set. Internal keys decode to
  `{sequence, operation, key, value}` — tombstones surface as
  `"delete"` records. Options: `max_results`, `verify_crc`,
  `include_index` (also list index-block keys, default false).
- `chrome_cache_parse` — one Chromium simple-disk-cache entry file:
  `SimpleFileHeader` (initial magic, version, key length, key hash), the
  stored key (usually a URL), trailing `SimpleFileEOF` record(s) at the
  documented 24/20-byte sizes, optional key SHA-256 verification when
  `FLAG_HAS_KEY_SHA256` is set, IEEE CRC-32 verification of each stream
  when `FLAG_HAS_CRC32` is set, combined stream-0+stream-1 layout
  resolution via the stream-0 `stream_size`, and a best-effort
  `HttpResponseInfo` pickle decode of stream 0 yielding
  `request_time`/`response_time`/`original_response_time` (Chromium
  internal time, reported as Unix seconds) plus the NUL-separated raw
  response headers. Sparse-range headers (`kSimpleSparseRangeMagicNumber`)
  are identified and reported. The simple entry format itself stores no
  per-file timestamps; entry times come from the stream-0 response-info
  pickle when present.
- `safari_cookies_parse` — one `Cookies.binarycookies` file: `"cook"`
  magic, big-endian page table, little-endian page/cookie records. Each
  cookie decodes to `{page, index, domain, path, name, secure, http_only,
  flags, expires_unix, created_unix, value, comment}` with the value as a
  bounded preview (<=512 bytes shown) and Mac-epoch timestamps converted
  to Unix seconds. Records are capped at 4096.
- `analyze` — sniffs the artifact kind (`cook` magic, simple-cache
  magics, sstable footer magic, then a CRC-verified LevelDB log probe)
  and runs the matching parser.

## Bounds

- input: 32 MiB; options JSON: 4 KiB; serialized output: 4 MiB
- result lists: 4096 records maximum
- snappy decompression: 64 MiB per block, declared length checked before
  allocation
- LevelDB table blocks walked: 4096; Safari pages: 4096, cookie record
  size: 16 KiB
- key/value previews: 512 UTF-8 chars + 64 hex bytes + full SHA-256

## Errors

Stable codes include `empty_input`, `input_too_large`, `options_too_large`,
`invalid_options`, `unknown_artifact`, `not_leveldb_log`,
`invalid_sstable`, `invalid_cache_entry`, `invalid_binarycookies`,
`internal_error`, `output_too_large`, and `serialization_error`. All
parsers run under `catch_unwind`; malformed input degrades to warnings or
error JSON, never a panic.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/browser-artifacts/Cargo.toml
wasm-pack build tools/browser-artifacts --target web --release --out-dir pkg
node tools/browser-artifacts/script/pack.mjs tools/browser-artifacts/pkg artifact/browser-artifacts-wasm
node tools/browser-artifacts/test/verify.mjs artifact/browser-artifacts-wasm/dist
cd artifact/browser-artifacts-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm32-unknown-unknown`,
wasm-opt `-Os --enable-bulk-memory --enable-nontrapping-float-to-int`.
