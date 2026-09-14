# Wasm Toolkit

Deeper WebAssembly tooling for Turen agent tools, built on the Bytecode
Alliance `wasm-tools` crates (`wasmparser`, `wasmprinter`, `wast`/`wat`,
`wasm-metadata`). It complements `tools/wasm-inspect`, which only validates a
binary and lists its sections; this target renders, profiles, and authors
modules.

All operations are parse-only: input bytes are decoded and validated but never
instantiated, interpreted, or executed.

## Relationship to `tools/wasm-inspect`

Use `wasm-inspect` for a cheap yes/no validation plus a section-offset table.
Use `wasm-toolkit` when an agent needs the actual contents: disassembled text,
typed imports/exports, feature detection, producers/name metadata, or to turn
authored `.wat` text into a binary for downstream tools.

## Operations

```text
wasm_print(bytes, options_json)    -> JSON string
wasm_analyze(bytes, options_json)  -> JSON string
wasm_metadata(bytes, options_json) -> JSON string
wat_compile(bytes, options_json)   -> Uint8Array, throws error JSON
```

`options_json` is a JSON object (empty string or `null` means defaults).
Expected failures return or throw
`{"schema_version":1,"error":"<code>"}` — for `wat_compile` the JSON string is
the thrown `JsValue`, and parse/encode errors add 1-indexed `line`, `column`,
and byte `offset` fields.

### `wasm_print`

Renders a module or component as `.wat` text. Options:

- `skeleton` (bool): omit function bodies and data contents.
- `foldExpressions` (bool): folded s-expression instruction form.
- `printOffsets` (bool): annotate lines with binary offsets.
- `maxWatBytes` (u64): output text cap, clamped to 8 MiB.

Result: `{schema_version, input_bytes, encoding, wat, wat_bytes, truncated}`.
The printer stops writing at the text cap; `truncated` reports it.

### `wasm_analyze`

Deep static profile of a module (or top-level outline of a component):

- `valid` / `valid_all_features` / `validation_error`: validation under the
  default (finished-proposal) feature set and under every known feature.
- `imports` / `exports`: `{module, name, kind, index, signature, detail}` —
  function and tag entries carry the resolved `(func (param ..) (result ..))`
  signature; tables, memories, and globals carry a limits/type `detail`.
- `functions`: defined-function count, aggregate code bytes, min/max body
  size, and a fixed power-of-two size histogram.
- `features`: every WebAssembly feature the binary provably requires, detected
  by re-validating with each feature removed from `WasmFeatures::all()` —
  a validation failure under an otherwise-accepting feature set proves the
  feature is used. Covers SIMD, relaxed-SIMD, threads/atomics, tail calls,
  exceptions, GC, function/reference types, bulk memory, multi-memory,
  memory64, extended-const, wide-arithmetic, multi-value, and more.
- `custom_sections`: `{name, offset, size, recognized, kind, depth}` for every
  custom section; recognized set includes `name`, `producers`,
  `target-features`, `sourceMappingURL`, `dylink.0`, `linking`, `reloc.*`,
  `coreDump*`, `component-name`, and branch hints.
- `start`, `elements`, `data`, `globals`, `memories`, `tables`, `tags`:
  segment modes, item/byte totals, init-expression kinds, and limits.
- `component`: for components, nested module/component counts and top-level
  section kinds; `types`/imports/exports/etc. describe the outermost scope
  only for core modules.

### `wasm_metadata`

- `producers`: decoded producers section as `{field: [{name, version}]}`.
- `name_section`: module/component name plus per-subsection entry counts.
- `source_mapping_url`: contents of the `sourceMappingURL` custom section.
- `component`: component imports/exports outline (`name`, `kind`, `index`,
  qualifiers) and nested module/component counts.
- `custom_sections`: inventory identical to `wasm_analyze`.

### `wat_compile`

UTF-8 `.wat` text in, validated wasm binary out — handy for agents authoring
test modules for other tooling. Binary input is rejected with
`expected_wat_text`; the produced binary is validated with `wasmparser` under
all known features before it is returned.

## Limits

```text
input bytes (binary or wat text)   32 MiB
options JSON                        4 KiB
JSON output (analyze/metadata)      4 MiB
wat text payload (print)            8 MiB  (envelope capped at 12 MiB)
every reported list              4,096 entries
compiled binary output             32 MiB
index spaces kept for sig lookup  256 K entries
```

Caps are enforced before the corresponding allocation or serialization; the
`.wat` printer aborts at its cap instead of materializing the whole document.

## Build

```sh
wasm-pack build tools/wasm-toolkit --target web --release --out-dir pkg
node tools/wasm-toolkit/script/pack.mjs tools/wasm-toolkit/pkg artifact/wasm-toolkit-wasm
node tools/wasm-toolkit/test/verify.mjs artifact/wasm-toolkit-wasm/dist
```

## Licensing

The wrapper is Apache-2.0 OR MIT (Turen Labs). The Bytecode Alliance
`wasm-tools` crates are Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT;
see `NOTICE` and `SOURCE.json`.
