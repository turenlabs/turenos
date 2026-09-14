# turen-unicode-audit-wasm

Bounded text encoding detection, WHATWG transcoding, and Unicode security
auditing for Turen agent tools, compiled to `wasm32-unknown-unknown` with
`wasm-bindgen`.

Built on:

- [`chardetng`](https://github.com/hsivonen/chardetng) 1.0.0 — Mozilla's
  encoding detector for legacy Web content
- [`encoding_rs`](https://github.com/hsivonen/encoding_rs) 0.8.41 — the WHATWG
  Encoding Standard implementation used by Gecko
- [`unicode-normalization`](https://github.com/unicode-rs/unicode-normalization)
  0.1.25 — NFC/NFD/NFKC/NFKD normalization (UAX #15)
- [`unicode-script`](https://github.com/unicode-rs/unicode-script) 0.5.8 —
  per-character Unicode `Script` property (UAX #24)

Every operation is deterministic, read-only, and offline: no filesystem,
network, environment, clock, subprocess, or analyzed-code-execution
capability is exposed.

## API

All operations accept the input bytes plus a small JSON options document and
return JSON text. Every success and error document carries
`"schema_version": 1`. Errors are JSON, never traps or throws:

```json
{"schema_version": 1, "error": "<code>", "message": "<detail>"}
```

Error codes: `input_too_large`, `options_too_large`, `options_invalid`,
`unknown_encoding`, `unsupported_target_encoding`, `invalid_normalize`,
`output_too_large`, `serialize_failed`.

### `text_detect(bytes, options_json) -> string`

Options: `{"tld": "<lower-case-dns-label>", "iso2022jp": <bool>}`.

Reports the guessed WHATWG encoding label, a derived `confidence`
(`high`/`medium`/`low`), `bom` (`utf-8`/`utf-16le`/`utf-16be`/`null`),
`utf8_valid`, `ascii_only`, the BOM-less UTF-16 byte-parity heuristics
`utf16_le_likely`/`utf16_be_likely`, `null_byte_ratio`, and `had_errors` /
`replacement_chars` for a trial decode with the guessed encoding.

A byte-order mark is checked before statistical detection (the WHATWG
sniffing order); `chardetng` itself never guesses UTF-16.

### `text_transcode(bytes, options_json) -> string`

Options:
`{"from": "<WHATWG label>|auto", "to": "utf-8", "normalize": "nfc|nfd|nfkc|nfkd"}`.

Decodes with `encoding_rs` (BOM-aware) from an explicit label or a `chardetng`
guess, applies optional normalization, and returns bounded UTF-8 `text`.
`to` only accepts labels that resolve to UTF-8 — output is always JSON-safe
UTF-8. Returns `had_errors`, `replacement_chars`, `decoded_bytes`,
`text_bytes`, and `truncated`.

### `unicode_audit(bytes, options_json) -> string`

Options: `{"maxFindings": <1..4096, default 4096>, "contextBytes": <0..128, default 40>}`.

Decodes the input as lossy UTF-8 (offsets, lines, and columns refer to that
decoded view) and reports, at each finding, `{kind, offset, line, col,
codepoint, name, context}` plus `length`/`scripts`/`identifier` where
relevant:

- `bidi_control` — LRE/RLE/PDF/LRO/RLO (U+202A–U+202E) and LRI/RLI/FSI/PDI
  (U+2066–U+2069), the CVE-2021-42574 "Trojan Source" primitives
- `bidi_mark` — LRM/RLM/ALM directional marks (U+200E, U+200F, U+061C)
- `invisible_char` — ZWSP/ZWNJ/ZWJ/WJ, soft hyphen, Hangul fillers,
  Mongolian vowel separator, invisible math operators, tag characters
  (U+E0000–U+E007F), supplementary variation selectors (U+E0100–U+E01EF),
  interlinear annotation anchors, and mid-text U+FEFF
- `unusual_whitespace` — NBSP, figure space, ideographic space, Ogham space,
  line/paragraph separators, and other Unicode space characters
- `control_char` — C0 controls other than tab/LF/CR, DEL, and C1 controls
- `mixed_script_identifier` — identifier tokens mixing letter scripts where
  at least one of Latin, Greek, or Cyrillic is present (homoglyph spoofing
  such as Cyrillic `а` U+0430 inside a Latin identifier)
- `bidi_reorder_span` — runs of RTL-script characters in lines that also
  contain non-RTL alphanumeric content, where display order diverges from
  storage order

The document includes `risk` (`none`/`low`/`medium`/`high`), a per-kind
`summary`, `findings_dropped`, `truncated`, `detected_encoding`, and
`warnings` (for example when the input was not detected as UTF-8).

Confusable-skeleton matching is intentionally not performed: no suitable
permissively-licensed Rust confusables crate exists, so homoglyph coverage is
reported through `mixed_script_identifier` only.

### `text_stats(bytes, options_json) -> string`

Options: `{"encoding": "<label>|auto", "tld": "<lower-case-dns-label>"}`.

Reports `encoding`, `bom`, `ascii_only`, `decoded_had_errors`,
`replacement_chars`, `codepoints`, `lines`, `longest_line` (`line`,
`codepoints`, `bytes`), `control_chars`, `nonprintable_chars` (controls plus
bidi/invisible format characters), and a `scripts` histogram over alphabetic
characters sorted by count (at most 64 buckets).

## Limits

Enforced before expensive allocation or serialization:

```text
input bytes            32 MiB
options JSON            4 KiB
JSON output             4 MiB
audit findings       4,096
decoded text            8 MiB (emitted text bounded by the output cap)
finding context       128 bytes
script histogram         64 buckets
```

## Build and verify

```sh
cargo test --manifest-path tools/unicode-audit/Cargo.toml
wasm-pack build tools/unicode-audit --target web --release --out-dir pkg
node tools/unicode-audit/script/pack.mjs tools/unicode-audit/pkg artifact/unicode-audit-wasm
node tools/unicode-audit/test/verify.mjs artifact/unicode-audit-wasm/dist
cd artifact/unicode-audit-wasm && shasum -a 256 -c SHA256SUMS
```

The packed artifact ships `dist/` (wasm-bindgen ESM output), `LICENSE`,
`NOTICE`, `README.md`, `SOURCE.json`, `package.json`, and `SHA256SUMS`.
