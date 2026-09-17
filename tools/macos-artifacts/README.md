# macOS forensic artifact parser for Turen

Bounded WebAssembly agent tool. Offline bytes only — no filesystem, network,
process, or environment access; the macOS counterpart to
`tools/windows-artifacts`.

## Operations

Every operation has the signature `(bytes: &[u8], options_json: &str) -> String`
and returns deterministic JSON. Expected failures return
`{"schema_version":1,"error":"<code>"}`.

- `plist_parse` — binary `bplist00` and XML property lists, auto-detected and
  streamed into bounded JSON. Data values become `{length, sha256, preview}`;
  typed node counts and maximum observed depth are reported. Options:
  `max_depth` (<=32), `max_items` (<=4096), `max_string_chars` (<=1024).
- `fsevents_parse` — `.fseventsd` disk logs: gzip-wrapped or raw
  `1SLD`/`2SLD`/`3SLD` pages decoded to `{event_id, path, flags, node_id}`
  records. Options: `max_results` (<=4096, default 256).
- `unified_log_parse` — `.tracev3` chunk streams (header, catalog, chunkset)
  reconstructed to `{timestamp, process, subsystem, category, level, message}`
  entries via Mandiant's `macos-unifiedlogs`. uuidtext/dsc/timesync files are
  not supplied, so unresolved format strings are explicit
  `<Missing message data>`-style markers plus counted warnings.
- `ds_store_parse` — `.DS_Store` buddy allocator + B-tree walk producing
  `{filename, code, type, value}` records; `Iloc` decodes to `{x, y}`, `bwsp`/
  `lsvp`/`lsvP`/`icvp` blobs decode inline as bounded plist JSON, other blobs
  report `{length, sha256, preview}`. Cyclic block graphs are guarded.
- `analyze` — sniffs the artifact kind and runs the matching parser.

## Bounds

- input: 32 MiB; options JSON: 4 KiB; serialized output: 4 MiB
- result lists: 4096 entries maximum
- fsevents gzip decompression: 64 MiB aggregate cap
- plist depth 32, per-container items 4096, events 4 Mi
- DS_Store: 4096 blocks walked, B-tree depth 4

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/macos-artifacts/Cargo.toml
wasm-pack build tools/macos-artifacts --target web --release --out-dir pkg
node tools/macos-artifacts/script/pack.mjs tools/macos-artifacts/pkg artifact/macos-artifacts-wasm
node tools/macos-artifacts/test/verify.mjs artifact/macos-artifacts-wasm/dist
cd artifact/macos-artifacts-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm32-unknown-unknown`,
wasm-opt `-Os --enable-bulk-memory --enable-nontrapping-float-to-int`.
