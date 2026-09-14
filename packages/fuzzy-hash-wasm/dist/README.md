# Fuzzy Hash

This package computes bounded cryptographic and similarity hashes for malware
triage and file comparison through a wasm-bindgen WebAssembly module. All
operations are deterministic, offline, byte-only, and never execute, extract,
or decompress the analyzed input.

## API

- `hash_all(bytes) -> JSON` — `{"schema_version":1,"bytes":N,"md5","sha1",
  "sha256","sha512","blake3","xxh64","imphash"}`. All digests are lowercase
  hex; `xxh64` is xxHash64 with seed 0. `imphash` is the standard
  pefile-convention MD5 over the lowercase comma-joined `library.function`
  import list in import order (`.ocx`/`.sys`/`.dll` extensions stripped,
  by-ordinal imports rendered as `ord<N>`), or `null` when the input does not
  parse as a PE or has no imports.
- `fuzzy_hash(algorithm, bytes) -> JSON` — `{"schema_version":1,"algorithm",
  "bytes":N,"hash"}`. `algorithm` is `"ssdeep"` (fuzzyhash crate, format
  `block:hash:hash`) or `"tlsh"` (tlsh2 crate, 72-character `T1...` form,
  128 buckets, 1-byte checksum).
- `fuzzy_compare(algorithm, hash_a, hash_b) -> JSON` — ssdeep returns
  `{"schema_version":1,"algorithm":"ssdeep","score":0-100}` (100 = identical;
  valid but incomparable hashes score 0). TLSH returns
  `{"schema_version":1,"algorithm":"tlsh","distance":N}` including the file
  length term (0 = identical, larger = more different).

Expected failures return `{"schema_version":1,"error":"code"}` rather than
throwing: `input_too_large` (input over 32 MiB), `options_too_large` (any
string argument over 4 KiB), `unknown_algorithm`, `invalid_hash` (malformed
hash string), `insufficient_data` (TLSH needs at least 50 bytes of
sufficiently varied input), `output_too_large`, `internal_error`.

## Limits

Input is capped at 32 MiB, string arguments at 4 KiB, the imphash import list
at 4,096 entries, and JSON output at 4 MiB. Limits are enforced before
allocation and serialization.

## Build

```sh
cargo test --manifest-path tools/fuzzy-hash/Cargo.toml
wasm-pack build tools/fuzzy-hash --target web --release --out-dir pkg
node tools/fuzzy-hash/script/pack.mjs tools/fuzzy-hash/pkg artifact/fuzzy-hash-wasm
node tools/fuzzy-hash/test/verify.mjs artifact/fuzzy-hash-wasm/dist
cd artifact/fuzzy-hash-wasm && shasum -a 256 -c SHA256SUMS
```

## Provenance

Wrapped crates are pinned with exact versions in `Cargo.toml` and
`Cargo.lock`; see `SOURCE.json` and `NOTICE` for the upstream set and
licenses. The shipped closure is permissively licensed (MIT, Apache-2.0,
BSD-3-Clause, BSL-1.0, or equivalents); no GPL or copyleft code is linked.
