# turen-apk-dex-wasm

Bounded, offline, **parse-only** static inspection of Android APKs and DEX
files for Turen agent tools, compiled to `wasm32-unknown-unknown` with
`wasm-bindgen`. Dalvik bytecode is never executed or emulated — code items
are only counted. No filesystem, network, environment, clock, or subprocess
capability is exposed.

The AXML, DEX, and ARSC decoders are hand-rolled and fully bounds-checked.
Published AXML crates were evaluated and rejected (`axml-parser` is
unpublished; `abxml` 0.8.2 needs a valid `resources.arsc` just to build its
decoder and pulls deprecated 2019-era deps; `rusty-axml` 0.2.1 hardcodes the
root element to `manifest`, leaves most typed values as TODO, orders
attributes nondeterministically through a `HashMap`, and panics on unknown
chunk types). The ZIP container is read through the pinned `zip` crate with
only the `deflate-flate2` feature enabled, backed by pure-Rust
`miniz_oxide` (`flate2` `rust_backend`).

## API

Every operation takes `(bytes, options_json)` and returns JSON text carrying
`"schema_version": 1`. Errors are JSON, never traps or throws:

```json
{"schema_version": 1, "error": "<code>", "message": "<detail>"}
```

Error codes: `input_too_large`, `options_too_large`, `options_invalid`,
`bad_magic`, `too_small`, `truncated`, `truncated_header`,
`malformed_header`, `missing_eocd`, `malformed_eocd`, `too_many_entries`,
`zip_parse_failed`, `entry_read_failed`, `dex_not_found`,
`dex_entry_too_large`, `table_out_of_bounds`, `unsupported_endian`,
`unsupported_variant_cdex`, `output_too_large`, `serialize_failed`,
`internal_panic`.

### `axml_decode(bytes, options_json) -> string`

Decodes an Android binary XML document (`AndroidManifest.xml` or any
compiled `res/` XML given as raw bytes) to text XML.

Options: `{"maxXmlBytes": <usize, clamped 1..1048576>}`.

Returns `kind:"axml"`, `xml` (capped at 1 MiB, `xml_truncated`), `elements`,
`attributes`, `max_depth`, `namespaces` (`{prefix, uri}`), `string_pool`
(`{count, utf8, sorted, styles}`), `warnings`, `truncated`. Typed attribute
values render per AOSP `Res_value` rules (int dec/hex, boolean, float,
`@0x…`/`?0x…` references, `#…` colors, `px/dip/sp/pt/in/mm` dimensions,
`%`/`%p` fractions).

### `dex_inspect(bytes, options_json) -> string`

Inspects one `.dex` file given as raw bytes. If the input is a ZIP/APK
(`PK\x03\x04`), `classesN.dex` is extracted first (`dexIndex` selects it).

Options: `{"dexIndex": <u32, default 1>, "limit": <usize, default 4096>,
"includeStrings": <bool, default true>}`.

Returns `kind:"dex"`, `header` (version, adler32 checksum, SHA-1 signature,
file/table geometry), `counts`, `stats` (`native_methods`,
`direct_and_virtual_methods`, `methods_with_code`), `strings`
(`{index, value}` — capped 4096 entries × 512 chars), `protos`
(`{shorty, return_type, params[]}`), `classes` (`{name, superclass,
interfaces[], access_flags, access[], source_file, fields, methods,
native_methods, methods_with_code}`), `map` (map_list entries), `findings`
(`{kind, match, source, index}` — `reflection`, `dynamic_loading`, `crypto`,
`exec`, `su_binary`, `shell`, `native`, `sms`, `webview`,
`webview_bridge`, `device_id`, `component_manipulation`, `network`),
`warnings`, `truncated`.

### `apk_inspect(bytes, options_json) -> string`

Inspects an APK as a ZIP container.

Options: `{"decodeManifest": <bool, default true>, "dexDetails": <bool,
default false>, "maxEntries": <usize, default 4096>,
"maxEntryBytes": <u64, default 33554432>}`.

Returns `kind:"apk"`, `zip.entry_count`, `zip.entries` (`{index, name,
method, method_name, size, compressed_size, crc32, dir}` — capped),
`manifest` (presence + the decoded AXML document embedded),
`dex_files` (`{name, size, sha256, dex_version, truncated}`, plus compact
`dex` stats when `dexDetails`), `resources_arsc.packages`
(`{id, name}`), `signing` (`v2_block`, `schemes[{id, name}]` —
`0x7109871a` v2 / `0xf05368c0` v3 / `0x1b93ad61` v3.1 — detected in the ZIP
preamble, `v1_signed`, `v1_entries`, `meta_inf_entries`), `warnings`,
`truncated`.

## Limits

```text
input bytes              32 MiB   (APKs are often larger — pass classesN.dex
                                   or the manifest bytes alone instead)
options JSON              4 KiB
JSON output               4 MiB
list items              4,096
decoded XML               1 MiB
DEX strings             4,096 x 512 chars
ZIP entries            65,536 pre-parse cap, 4,096 reported
per-entry decompressed   32 MiB   (zip-bomb bound; hashes only when fully read)
AXML elements          65,536, depth 256, attributes 131,072
findings                1,024
```

## Boundary notes

- The `zip` crate only sees an in-memory `Cursor`; nothing is extracted to a
  host filesystem — selected entries are returned as bounded data or decoded
  inside the module.
- The EOCD entry count is checked (≤65,536) before `ZipArchive` allocates
  its member table, and each entry is read through a hard byte cap.
- All parses run under `catch_unwind`; a hypothetical panic in a dependency
  degrades to `{"error":"internal_panic"}` rather than a trap.
- Signing data is *detected*, never verified — `signatureVerification` stays
  false in `SOURCE.json` (that is the `code-signing` target's job).

## Build

```sh
cargo test --manifest-path tools/apk-dex/Cargo.toml --locked
wasm-pack build tools/apk-dex --target web --release --out-dir pkg
node tools/apk-dex/test/verify.mjs tools/apk-dex/pkg
node tools/apk-dex/script/pack.mjs tools/apk-dex/pkg artifact/apk-dex-wasm
```

Requires Rust 1.97.1 and wasm-pack 0.15.0; see `SOURCE.json` for provenance.
Test fixtures (binary AXML, minimal DEX, resources.arsc, APK ZIPs with
stored/deflated entries and a spliced v2 signing block) are fabricated
byte-by-byte in `src/fixtures.rs` (Rust tests) and `test/verify.mjs` (the
real WASM module) — no mocks.
