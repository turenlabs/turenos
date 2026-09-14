# turen-sourcemap-wasm

Bounded, offline source-map decoding for Turen agent tools. The module wraps
the crates.io [`sourcemap`](https://github.com/getsentry/rust-sourcemap) crate
(`9.3.2`, BSD-3-Clause, default features disabled) behind a narrow
wasm-bindgen API for minified-JavaScript analysis: development debugging and
JavaScript malware deobfuscation support.

All positions are 0-indexed, matching the source-map v3 token convention.

## Operations

Every operation takes the raw `.map` bytes and a small JSON options document.
All positions are 0-indexed.

### `sourcemap_inspect(bytes, optionsJson) -> string`

Parses a `.map` and returns a JSON summary string:

- `kind`: `"regular"`, `"index"` (sectioned), or `"hermes"` (Metro/React
  Native maps carrying `x_facebook_sources`).
- `version`, `file`, `source_root`, `debug_id` as present in the document.
- `sources`: bounded list of `{index, source, source_truncated, ignored,
  has_content, content_bytes, content_sha256}`. Embedded `sourcesContent` is
  **never inlined** — only its presence, byte size, and SHA-256 are reported.
- `sources_count`, `names_count`, `mappings_count`, `ignore_list`,
  `ignore_list_present`, `x_google_ignore_list_present`,
  `range_mappings_present`, and the `x_facebook_*`/`x_metro_*` extension flags.
- Index maps: `sections` with `{index, offset, url, embedded, embedded_kind,
  sources_count, names_count, mappings_count}` per section, plus
  `sections_count` and `unresolved_sections` (sections that only name an
  external URL).

Options: `{"maxSources": 4096, "maxSections": 4096}` (both clamped to 4,096).

### `sourcemap_lookup(bytes, optionsJson) -> string`

Maps a generated (minified) position to the closest original token. Options:
`{"line": <u32>, "column": <u32>}` — both required.

Returns `{"found": bool, "token": {...}, "warnings": [...]}`. The token has
`generated`, `mapped`, `source`, `source_index`, `original`, `name`, and
`is_range`. Lookup resolves to the greatest lower bound: a position between
two mappings returns the preceding token, and a position past the last mapping
clamps to the final token. An unmapped generated segment returns
`"mapped": false` with null source fields.

On index maps, lookups inside embedded sections return global generated
coordinates; positions inside sections that only reference an external URL
return `"found": false` with a warning — they are never fetched.

### `sourcemap_reverse_lookup(bytes, optionsJson) -> string`

Maps an original source position to the generated positions it produced.
Options: `{"source": "<path>" | "sourceIndex": <u32>, "line": <u32>,
"column": <u32, optional>, "maxPositions": 4096}`. `line` is required; omit
`column` to match every mapping on the line.

`source` resolution tries exact match, then `./`-normalized match, then a
`/`-boundary suffix match (`app.js` matches `webpack://x/./app.js`).
`sourceIndex` takes precedence over `source`. Returns `positions`
(`{line, column, name, is_range}`, capped at `maxPositions`), `match_count`,
`scanned_tokens`, `matched_sources`, and `truncated`. Index maps are flattened
first, so indexes refer to the flattened source list.

### `sourcemap_source(bytes, optionsJson) -> Uint8Array`

Extracts exactly one embedded `sourcesContent` entry as a single bounded byte
vector — **not** JSON — so large sources never inflate a serialized document.
Options: `{"index": <u32>} or {"path": "<source path>"}`; `index` takes
precedence, `path` resolves like `reverse_lookup`'s `source`. Index maps are
flattened first.

Missing content returns `no_source_content`, an unknown index/path returns
`source_not_found`, and content over 8 MiB returns `source_too_large`. Errors
are thrown as a `JsError` whose `message` is the JSON error document.

### `sourcemap_flatten(bytes, optionsJson) -> Uint8Array`

Resolves a sectioned index sourcemap into a regular v3 sourcemap and returns
the map JSON as one bounded byte vector (cap 32 MiB). Sources are deduplicated
and renumbered. A regular map flattens to itself (normalization); a Hermes map
flattens to its inner regular map, dropping `x_facebook_sources` scope
metadata. A section that only references an external URL fails with
`unresolved_sections` — nothing is ever fetched.

## Errors

Expected failures return (or throw) a JSON document:

```json
{"schema_version": 1, "error": "<code>", "message": "<detail>"}
```

Codes include `input_too_large`, `options_too_large`, `options_invalid`,
`missing_option`, `invalid_json`, `invalid_utf8`, `invalid_mappings`,
`bad_source_reference`, `bad_name_reference`, `not_a_sourcemap`,
`unresolved_sections`, `source_not_found`, `no_source_content`,
`source_too_large`, `flattened_too_large`, `output_too_large`, and
`internal_panic` (a parser panic is caught and degraded — it can never trap
the host).

## Hard limits

Enforced before unbounded allocation or serialization:

| Bound | Limit |
| --- | --- |
| input bytes | 32 MiB |
| options JSON | 4 KiB |
| JSON output | 4 MiB |
| list items (sources, sections, positions, ignore list) | 4,096 |
| extracted source | 8 MiB |
| flattened map output | 32 MiB |
| emitted strings | 1 KiB each |

## Isolation

The module accepts bytes plus options and returns bounded JSON or one bounded
byte vector. It has **no filesystem, network, environment, or subprocess
access, and never executes analyzed code**. External section URLs and
`sourceRoot`-relative references are reported but never resolved.

## Provenance

- Upstream: `sourcemap` `9.3.2` from crates.io
  (`https://github.com/getsentry/rust-sourcemap`), BSD-3-Clause, used
  unmodified with default features disabled (`ram_bundle` is excluded).
- Crate tarball SHA-256:
  `314d62a489431668f719ada776ca1d49b924db951b7450f8974c9ae51ab05ad7`.
- Wrapper: `turen-sourcemap-wasm`, Apache-2.0 OR MIT, Rust `1.97.1`,
  wasm-bindgen `0.2.108`, wasm-pack `0.15.0`.
- The full runtime dependency and license inventory is in `SOURCE.json`;
  attribution is in `NOTICE`.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/sourcemap/Cargo.toml
wasm-pack build tools/sourcemap --target web --release --out-dir pkg
node tools/sourcemap/script/pack.mjs tools/sourcemap/pkg artifact/sourcemap-wasm
node tools/sourcemap/test/verify.mjs artifact/sourcemap-wasm/dist
cd artifact/sourcemap-wasm && shasum -a 256 -c SHA256SUMS
```

`cargo test` runs the Rust suite (fabricated maps, hand-encoded VLQ, index and
Hermes maps, malformed input, bounds, determinism). `verify.mjs` loads the
real compiled WASM and exercises every operation, including malformed and
oversized inputs, with no mocks.
