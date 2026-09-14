# binary-diff

Bounded binary differencing and patching for Turen agent tools, compiled to
WebAssembly with wasm-bindgen — firmware delta operations over two
caller-supplied buffers: changed-region comparison, cheap alignment reports,
`bipatch`-format patch production, patch application with optional output
integrity verification, and patch introspection.

The module is deterministic and offline: no filesystem, network, subprocess,
environment, or clock access. Malformed or hostile input returns structured
errors and never panics.

## Two-input container convention

The wasm ABI passes one input buffer, so operations that need two byte
buffers take a single UTF-8 **JSON input document** whose fields are
canonical (padded, strict-trailing-bits) base64 strings:

- `binary_compare`, `binary_regions`, `binary_diff`:
  `{"old": "<base64>", "new": "<base64>"}`
- `binary_patch`: `{"old": "<base64>", "patch": "<base64>"}`
- `binary_patch_info` is the exception: its `input` is the raw patch bytes.

Each decoded embedded buffer is capped at 32 MiB; the base64 field length is
checked **before** decoding so an oversized field never reaches the decoder.

## Operations

JSON-report operations return a `String` of JSON beginning with
`"schema_version": 1`. Byte-producing operations return one `Uint8Array`.
Expected failures are reported as `{"schema_version":1,"error":"<code>"}` —
returned as the report string for JSON operations and thrown as a `JsError`
whose message is the same JSON envelope for byte operations.

| Function | Signature | Result |
| --- | --- | --- |
| `binary_compare` | `(input, options) -> JSON` | Structural comparison: `identical`, sizes, `size_delta`, `common_prefix`/`common_suffix`, bounded `regions` list with per-region hex `preview`, entropy, and byte-class hints, `sha256_old`/`sha256_new`, `matched_bytes`, `matching_ratio`, and `similarity_score` (0–100 with a region-count penalty) |
| `binary_regions` | `(input, options) -> JSON` | Cheaper changed-region report. Equal-size buffers use an exact `aligned-scan`; different sizes use a `rolling-hash` scan anchoring on a 64-byte grid of `old` blocks (hits are byte-verified, so the report stays exact) |
| `binary_diff` | `(input, options) -> bytes` | Produce a `bipatch`-format patch transforming `old` into `new`: single-threaded port of the bidiff/bsdiff suffix-array partition scan over `divsufsort` |
| `binary_patch` | `(input, options) -> bytes` | Apply a `bipatch` patch to `old` via the upstream `bipatch` decoder; `expectedSha256` option verifies the output (`checksum_mismatch` on failure — patches carry no checksum of their own) |
| `binary_patch_info` | `(input, options) -> JSON` | Triage raw patch bytes: `format`, `magic`/`version`, `well_formed`/`complete`, `control_count`, `add_bytes`/`copy_bytes`/`output_bytes`, `old_bytes_touched`, `rewind_bytes`, `truncated`, `warnings` |

## Options

```json
{"maxRegions": 4096, "maxOutputBytes": 134217728, "expectedSha256": "<64 hex>"}
```

- `maxRegions` (1–4096): caps the collected region list; `region_count`
  still reports the true total and `truncated` flags the cut.
- `maxOutputBytes` (1–134217728): caps `binary_diff`/`binary_patch` output,
  enforced while writing/applying, not after.
- `expectedSha256`: 64-hex digest verified against the `binary_patch`
  result after apply; mismatch is a hard `checksum_mismatch` error.

## Patch format

`binary_diff` emits and `binary_patch`/`binary_patch_info` consume the
`bipatch` wire format (`bipatch` 1.0.0, from divvun/bidiff):

```text
u32le magic   = 0xB1DF
u32le version = 0x1000
repeat until EOF:
  varint add_len  | add_len diff bytes   (new[i] - old[i], wrapping)
  varint copy_len | copy_len literal bytes
  varint seek     (signed; moves the old cursor)
```

The format stores diff/copy bytes uncompressed, so a patch is bounded by
`new` plus control overhead regardless of how much content matches.

## Hard limits

| Bound | Value |
| --- | --- |
| Input document bytes | 92 MiB (`input_too_large`) |
| Embedded buffer (`old`/`new`/`patch`) | 32 MiB each (`input_too_large`) |
| `binary_patch_info` raw patch | 32 MiB (`input_too_large`) |
| Options JSON | 4 KiB (`options_too_large`) |
| JSON report output | 4 MiB (`output_too_large`) |
| Reported regions | 4,096 (`truncated`) |
| Diff/patch output bytes | 128 MiB (`output_too_large`) |
| `patch_info` control records walked | 1,000,000 (`control_limit_reached`) |

Limits apply before allocation or serialization. Transforms never return
partial output.

## Error codes

`input_too_large`, `options_too_large`, `invalid_options`,
`invalid_input`, `invalid_base64`, `invalid_patch`, `checksum_mismatch`,
`output_too_large`, `internal_error`.

## Build and verify

```sh
cargo test --manifest-path tools/binary-diff/Cargo.toml
wasm-pack build tools/binary-diff --target web --release --out-dir pkg
node tools/binary-diff/script/pack.mjs tools/binary-diff/pkg artifact/binary-diff-wasm
node tools/binary-diff/test/verify.mjs artifact/binary-diff-wasm/dist
cd artifact/binary-diff-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned in
`.github/workflows/build-binary-diff.yml`, which runs the same sequence on
the self-hosted runner and uploads `artifact/binary-diff-wasm`.

`test/verify.mjs` exercises the real compiled module end to end — identity,
insert/delete/scattered edits, round-trip byte-exactness, determinism,
tamper and checksum handling, and every input/options bound; Rust unit
tests cover the same surface plus PRNG-content fuzzing of the document
parser and patch decoder.

## Layout

```text
src/lib.rs       wasm-bindgen boundary, input document, options, limits, errors
src/bsdiff.rs    ported bsdiff-style scan + bipatch writer
src/compare.rs   binary_compare report + binary_regions rolling-hash scan
src/patch.rs     bipatch application + patch_info walker
test/verify.mjs  real-WASM behavioral checks
script/pack.mjs  Forge artifact packer + SHA256SUMS
```

## Provenance

The diff scan is a Turen port of the bsdiff-style matcher in divvun/bidiff
1.0.0 (Apache-2.0 OR MIT, itself derived from Colin Percival's bsdiff,
BSD-2-Clause); rayon and timing paths are removed. `bipatch` 1.0.0 is linked
unmodified for patch decoding. Runtime dependencies are exact-pinned
crates.io releases committed in `Cargo.lock`: divsufsort/sacabase (MIT),
data-encoding (MIT), integer-encoding (MIT), byteorder (Unlicense OR MIT),
sha2 (MIT OR Apache-2.0), serde/serde_json, wasm-bindgen. See `SOURCE.json`
and `NOTICE`.
