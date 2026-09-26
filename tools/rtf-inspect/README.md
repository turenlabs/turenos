# rtf-inspect WASM

Bounded, offline RTF (Rich Text Format) inspection for TurenOS document
triage. RTF is a classic exploit-document carrier: `\objdata` OLE payloads,
`{\*\filetbl}` embedded files, `{\template}` remote-template paths,
`{\field}` external references, and obfuscation by fragmented control words.
This module parses those structures deterministically without executing any
embedded content.

Hand-rolled parser. No vendored upstream source. Pure Rust, no filesystem,
network, or process access.

## Operations

All four operations share the same ABI:

```text
fn(input_bytes, options_json) -> JSON string
```

- `rtf_inspect` — structural report: group tree stats (max depth, group
  count, balance, trailing bytes after final `}`), top-N control-word
  histogram, `{\fonttbl}` fonts, `{\stylesheet}` styles, `{\colortbl}`
  colors, `{\*\generator}` producer, `{\info}` title/author/creation time,
  `{\pict}` summaries (type, dimensions, byte count), `{\*\datastore}`,
  `{\*\filetbl}` filenames and OLE package indicators.
- `rtf_objects` — embedded-object enumeration: objclass name, declared
  width/height, decoded `\objdata` byte count, SHA-256, first-16-byte hex
  preview, OLE compound-file magic (`d0cf11e0`) detection, `result`/`resultx`
  rendering data, malformed-hex detail (odd length, bad characters).
  Optional `{"include_payload_hex":true}` inlines the full payload only when
  it is at or below 64 KiB.
- `rtf_audit` — security findings, each `{kind, offset, detail, severity}`:
  - embedded content: `objdata_payload`, `ole_compound_object`,
    `malformed_objdata`, `suspicious_objclass`, `datastore`, `file_table`,
    `embedded_file`, `binary_blob`, `template_path`;
  - fields: `field_external_ref` (INCLUDETEXT / INCLUDEPICTURE / LINK /
    IMPORT, and HYPERLINK / EMBED / MACROBUTTON / AUTOTEXT / GOTOBUTTON),
    `form_field` (FORMTEXT / FORMCHECKBOX / FORMDROPDOWN),
    `field_instruction` (any other field);
  - obfuscation: `password_protection`, `control_density`,
    `control_fragmentation`, `overlong_control_name`,
    `excess_ignorable_groups`, `hex_heavy_region`, `hex_obfuscation`,
    `malformed_hex_escape`, `fragmented_text`, `unicode_anomaly`,
    `mixed_encodings`;
  - structure: `deep_nesting`, `extreme_nesting`, `unbalanced_braces`,
    `stray_closing_brace`, `missing_rtf_header`, `unusual_rtf_version`,
    `leading_data`, `trailing_data`.
- `rtf_text` — bounded plain-text extraction: strips control words,
  resolves `\'hh` and `\uN` (with `\uc` fallback skipping and negative-value
  wrap), skips `fonttbl`/`stylesheet`/ignorable `\*` destinations and
  object/metadata destinations, caps output characters, reports
  `truncated` and paragraph count.

## Envelope

Success responses start with `"schema_version":1`. Failures return
`{"schema_version":1,"error":"<code>","message":"<detail>"}`.

## Limits

| bound | value |
| --- | --- |
| input | 16 MiB |
| options JSON | 4 KiB |
| JSON output | 4 MiB |
| findings / array items | 4,096 |
| group depth (descend) | 64; deeper branches flagged, scanner continues |
| control-word histogram | top 32 (configurable ≤ 256) |
| `\objdata` decoded payload | streaming; bounded by input (≤ 8 MiB), first 64 KiB retained |
| inline payload hex | 64 KiB, opt-in only |
| extracted text | 512 KiB chars |
| preview strings | 1,024 chars |

Bounds are enforced before allocation and serialization. Parsing is
read-only; embedded objects, fields, and OLE payloads are never executed,
instantiated, or written anywhere.

## Build

```sh
cargo test --manifest-path tools/rtf-inspect/Cargo.toml --locked
wasm-pack build tools/rtf-inspect --target web --release --out-dir pkg
node tools/rtf-inspect/test/verify.mjs tools/rtf-inspect/pkg
node tools/rtf-inspect/script/pack.mjs tools/rtf-inspect/pkg artifact/rtf-inspect-wasm
cd artifact/rtf-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain pins: Rust 1.97.1, wasm-pack 0.15.0, wasm32-unknown-unknown.
