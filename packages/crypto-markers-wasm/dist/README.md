# Turen Crypto Markers (WASM)

Bounded findcrypt-style cryptographic-artifact detection and byte-structure
profiling for Turen agent tools. The module scans raw bytes for known
cryptographic constants, algorithm-identifier OIDs, key-structure templates,
and keying-material strings, and produces Shannon-entropy maps, XOR-key
candidates, and byte histograms for malware triage.

All processing is deterministic, read-only, and offline: the module never
executes analyzed code, never touches filesystem, network, environment, or
clock APIs, and enforces every limit before allocation.

## Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/crypto-markers/Cargo.toml
wasm-pack build tools/crypto-markers --target web --release --out-dir pkg
node tools/crypto-markers/script/pack.mjs tools/crypto-markers/pkg artifact/crypto-markers-wasm
node tools/crypto-markers/test/verify.mjs artifact/crypto-markers-wasm/dist
cd artifact/crypto-markers-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm32-unknown-unknown`, release
`wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int`.

## API

Each operation accepts `bytes` plus a JSON options string (max 4 KiB) and
returns a JSON string. All reports carry `"schema_version": 1`. Expected
failures return `{"schema_version":1,"error":"<code>","message":"<detail>"}` —
the module never throws or traps on malformed input.

### `crypto_constants(bytes, options)`

Reports each match as
`{algorithm, constant_name, kind, offset, size, endianness, confidence}`.

Options: `maxFindings` (default 4096, clamped 1–4096), `minConfidence`
(`"low"`|`"medium"|"high"`, default `"low"`), `algorithms` (string filter).
snake_case aliases are accepted for every option.

Coverage:

- AES (FIPS-197): S-box, inverse S-box, Rcon, encryption T-tables Te0–Te3,
  decryption T-tables Td0–Td3
- SHA-1 and SHA-256 initial vectors in both little- and big-endian forms;
  SHA-512 IVs (FIPS 180-4)
- MD5 sine table `T[64]` (RFC 1321)
- ChaCha20 `expand 32-byte k`/`expand 16-byte k` sigma (RFC 8439) and Salsa20
  sigma/tau strings
- Camellia (RFC 3713), Serpent, Twofish, Blowfish, and DES (FIPS 46-3) S-boxes
  and fixed tables
- DER algorithm-identifier OIDs: rsaEncryption, sha256WithRSA,
  ecdsa-with-SHA256, prime256v1, secp384r1, secp256k1, curve25519, ed25519,
  and related common identifiers
- ASN.1 PKCS#1/PKCS#8/SPKI header templates, PEM armor (RFC 7468), JWT `eyJ`
  shapes (RFC 7519), bcrypt `$2a$`/`$2b$`, argon2 encoded strings, and simple
  ransomware/malware crypto markers
- 32-bit tables are scanned in both little- and big-endian forms

Findings are capped at 4096 (`truncated: true` when more match). RC4
key-schedule detection is intentionally omitted: byte-pattern detection of
RC4 KSA produces unacceptable false-positive rates.

### `entropy_map(bytes, options)`

Sliding-window Shannon entropy. Options: `windowSize` (default 4096, clamped
16–4 MiB), `stride` (default 4096, clamped 1–4 MiB).

Each region reports `offset`, `size`, `entropy` (two decimals), `ascii`,
`null`, and `high` byte-class percentages plus a `classification` hint:
sustained entropy above 7.2 suggests encrypted/compressed/packed data,
roughly 4–6 suggests code or structured data, below 2 suggests sparse padding.
The report also includes overall entropy, highest/lowest-entropy region
references, and `max_consecutive_high_entropy`. Regions are capped at 4096.

### `xor_probe(bytes, options)`

Single-byte XOR keys 0x00–0xFF scored exhaustively; multi-byte keys up to
length 8 are recovered per residue class or derived exactly from a
known-plaintext crib. Candidates report
`{key, length, method, score, printable_ratio, magic_hits, preview_hex}`
where `preview_hex` decodes at most 64 bytes.

Scoring combines printable-ASCII ratio with magic/content hits: MZ, ELF,
PK/ZIP, %PDF, PNG, `-----BEGIN`, `http(s)://`, HTTP verbs/headers, common
Windows strings, and similar.

Options: `topK` (default 8, max 64), `scanBytes` (default first 256 KiB,
max 4 MiB), `maxKeyLength` (default 1, max 8), `minScore`, `keys` (explicit
hex keys, 1–32 bytes each, max 64), `crib` / `cribHex` (known plaintext, max
64 bytes). Multi-byte heuristic recovery is best-effort on short inputs; a
`crib` placement derives the exact repeating key when the crib is at least as
long as the key.

### `byte_stats(bytes, options)`

Whole-buffer profile: `length`, `entropy`, `unique_bytes`, `null_ratio`,
`ascii_printable_ratio`, `high_ratio`, `top_bytes` histogram,
`line_endings` (`lf`/`crlf`/`cr_only`), `longest_run`, and `strings` counts
(ASCII and UTF-16LE runs at `minStringLength`, default 4).

## Hard limits

```text
input bytes             32 MiB
options JSON             4 KiB
JSON output              4 MiB
findings/results/regions 4,096
XOR scan default       256 KiB (4 MiB max)
XOR key length               8
decoded preview           64 bytes
crib                      64 bytes
```

## Provenance and licensing

Original implementation. Constant tables are transcribed from public
specifications: FIPS-197, FIPS 180-4, FIPS 46-3, RFC 1321, RFC 3713,
RFC 7468, RFC 7519, RFC 8439, RFC 3279, RFC 5280, RFC 5480, RFC 5758,
RFC 8017, RFC 8410, and the public Serpent/Twofish/Blowfish specifications.
See `NOTICE` and `SOURCE.json`.

Dependencies (pinned in `Cargo.lock`): serde 1.0.229, serde_json 1.0.151,
wasm-bindgen 0.2.127 — all MIT OR Apache-2.0. The crate itself is
`MIT OR Apache-2.0`; see `LICENSE`.

## Deviations

- `xor_probe` adds optional `crib`/`cribHex` known-plaintext options beyond
  the minimal required schema; heuristic multi-byte recovery alone cannot
  reliably recover arbitrary keys from short inputs.
- RC4 key-schedule code-pattern detection is intentionally not implemented.
- Raw byte-sequence signatures (S-boxes, OIDs, strings) report
  `endianness: "none"`; 32/64-bit tables report `"little"`/`"big"`
  explicitly.
