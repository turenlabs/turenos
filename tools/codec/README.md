# turen-codec-wasm

Bounded compression and encoding transforms for Turen agent tooling, compiled
to WebAssembly with wasm-bindgen. The module is deterministic, offline, and
pure Rust: no filesystem, network, subprocess, environment, or clock access.
Malformed or hostile input returns structured JSON errors and never panics.

## Operations

All byte-returning operations take an options JSON string and return one
`Uint8Array`. Expected errors throw a `JsError` whose message is a JSON object:

```json
{ "schema_version": 1, "error": "decompress_failed", "detail": "..." }
```

### `decompress(algorithm, bytes, options_json)`

| algorithm | notes |
| --- | --- |
| `gzip` (`gz`) | multi-member streams decoded; non-gzip trailing bytes ignored |
| `zlib` | trailing bytes after stream end ignored |
| `deflate` | raw DEFLATE, no header |
| `brotli` (`br`) | standard window (<= 16 MiB); large-window streams rejected |
| `lz4` | LZ4 frame format; concatenated and skippable frames handled |
| `lz4-block` | raw LZ4 block with 4-byte little-endian size prefix |
| `bzip2` (`bz2`) | decode only |
| `xz` | xz container; index pre-scanned for declared output size |
| `lzma` (`lzma-alone`) | LZMA-Alone headers |
| `lzma2` | raw LZMA2 chunks; header pre-scanned for declared output size |
| `zstd` (`zst`) | decode only; concatenated frames decoded |

### `compress(algorithm, bytes, options_json)`

Same algorithms minus the decode-only ones: `gzip`, `zlib`, `deflate`,
`brotli`, `lz4`, `lz4-block`, `xz`, `lzma`, `lzma2`. `bzip2` and `zstd`
return `unsupported` — `bzip2-rs` ships no encoder and this module's zstd
scope is decode-only. Output is deterministic for fixed input and level.

### `encode(encoding, bytes, options_json)` / `decode(encoding, bytes, options_json)`

| encoding | notes |
| --- | --- |
| `hex` | lowercase on encode; mixed case and interior whitespace tolerated on decode |
| `base64`, `base64url` | padded on encode; missing padding tolerated on decode |
| `base32`, `base32hex` | padded on encode; lowercase/missing padding tolerated |
| `base58` | Bitcoin alphabet |
| `base58check` | version byte + 4-byte checksum variant |
| `z85` (`base85`) | ZeroMQ RFC 32; input length must be a multiple of 4 (5 on decode) |
| `quoted-printable` (`qp`) | RFC 2045; lone CR/LF are escaped as `=0D`/`=0A` so arbitrary bytes round-trip exactly; only CRLF pairs are literal line breaks |
| `uuencode` (`uudecode`, `uu`) | emits `begin 644 -`; decoder locates the `begin`/`end` block inside input |

### `detect(bytes)`

Returns a JSON string report:

```json
{
  "schema_version": 1,
  "inputBytes": 6,
  "primary": "hex",
  "candidates": [{ "kind": "encoding", "name": "hex", "confidence": "low", "detail": "..." }]
}
```

Magic-byte detection for gzip (`1f8b`), zlib (`CMF/FLG` with FCHECK),
xz (`fd377a585a00`), zstd (`28b52ffd`, plus skippable frames), LZ4
(`04224d18`), bzip2 (`BZh1`-`BZh9`), and LZMA-Alone header shape. Charset
sniffing reports base64/base64url/base32/base58/z85/hex compatibility at
`low` or `medium` confidence. Raw deflate, raw LZMA2, and Brotli carry no
reliable magic bytes and are not guessed from content. Detection is
read-only — nothing is decoded or decompressed.

## Options

| key | type | default | notes |
| --- | --- | --- | --- |
| `maxOutputBytes` | integer | 128 MiB | hard cap; values above the maximum clamp down |
| `expectedOutputBytes` | integer | 0 | pre-reservation hint, capped at 4 MiB |
| `level` | integer | per-codec | deflate 0-9 (default 6), brotli 0-11 (default 5); clamped, ignored elsewhere |

## Hard limits

| resource | limit |
| --- | --- |
| input bytes | 32 MiB (`input_too_large` when exceeded) |
| options JSON | 4 KiB (`options_too_large`) |
| `detect` report | 4 MiB |
| transform output | 128 MiB (`output_too_large`, no partial output) |
| LZMA dictionary | 64 MiB (`lzma` decode `memlimit`) |
| zstd window | 64 MiB |
| brotli window | 16 MiB (strict; large-window streams rejected) |
| size-hint pre-reservation | 4 MiB |

Output caps are enforced while bytes stream out — decoders write through a
bounded sink that aborts at the cap, and declared sizes (LZ4 content size,
xz index, LZMA2 chunk headers, `lz4-block` prefix, zstd window) are checked
before decoding begins. `lzma2`/`xz` decoder history buffers grow with
produced output and are bounded by the same cap.

## Error codes

`input_too_large`, `options_too_large`, `invalid_options`,
`output_too_large`, `unknown_algorithm`, `unknown_encoding`,
`invalid_input`, `decode_failed`, `decompress_failed`, `compress_failed`,
`truncated`, `unsupported`.

`truncated` means the input ended before the codec's declared structure
finished; `decompress_failed`/`decode_failed` cover corrupt or
wrong-algorithm input. Partial output is never returned on failure.

## Build, test, package

```sh
cargo test --manifest-path tools/codec/Cargo.toml
wasm-pack build tools/codec --target web --release --out-dir pkg
node tools/codec/test/verify.mjs tools/codec/pkg
node tools/codec/script/pack.mjs tools/codec/pkg artifact/codec-wasm
node tools/codec/test/verify.mjs artifact/codec-wasm/dist
cd artifact/codec-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned in
`.github/workflows/build-codec.yml`, which runs the same sequence on the
self-hosted runner and uploads `artifact/codec-wasm`.

## Layout

```text
src/lib.rs       wasm-bindgen boundary, options parsing, limits, error JSON
src/bounded.rs   bounded reader/writer sinks
src/codec.rs     compression algorithms + format pre-scans
src/encoding.rs  text encodings (hex/base64/base32/base58/z85/QP/uu)
src/detect.rs    magic-byte and charset detection
test/verify.mjs  real-WASM behavioral checks
script/pack.mjs  Forge artifact packer + SHA256SUMS
```
