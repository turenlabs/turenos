# capa-match

Bounded static-subset capa capability matcher for Turen agent tools,
compiled to WebAssembly with wasm-bindgen. The module embeds a compiled
form of the [mandiant/capa-rules](https://github.com/mandiant/capa-rules)
ruleset at commit `805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5` (~1,050
rules) and evaluates it over caller-supplied bytes.

The module is deterministic and offline: no filesystem, network,
subprocess, environment, or clock access. Malformed or hostile input
returns structured errors and never panics.

## Static-subset honesty boundary

**This is not the capa engine.** There is no disassembly and no
function-, basic-block-, call-, or instruction-scope analysis. Only
file-scope features are extracted:

- `format:`, `os:`, `arch:` globals (PE/ELF/Mach-O/archive via vendored
  goblin 0.10.6)
- `section:`, `import:`, `export:`, and import-table `api:` names
- `string:`/`substring:` over the ASCII and UTF-16LE string tables
- `bytes:` exact and wildcard patterns
- `characteristic: embedded pe` and `characteristic: forwarded export`

Features requiring disassembly (`number:`, `offset:`, `mnemonic:`,
`operand*`, `property*`, `class:`, `namespace:`, `function-name:`,
`com/*`, `basic blocks`) never match. Statements under a narrower scope
(`basic block:`, `function:`, `call:`, ...) are unsatisfiable.

Compile-time constant folding applies `unsupported → false` under capa
semantics: an `and:`-required unsupported feature makes the whole rule
unsatisfiable (reported under `skipped_by_reason` /
`skipped_rules` with `requires-unsupported-features` or
`static-scope-unsupported`), while dropped `or:` branches and negations
keep the rule evaluable and mark it `degraded` with a per-rule
`unsupported` kind list. Reported matches are therefore a **lower
bound**: genuine file-scope matches are reported; rules that could only
match through unobservable features are skipped or flagged — never
fabricated.

## Operations

Every operation returns a JSON `String` beginning with
`"schema_version": 1`. Expected failures return
`{"schema_version":1,"error":"<code>","message":"<detail>"}` as the same
string — the boundary never throws.

| Function | Signature | Result |
| --- | --- | --- |
| `capa_match` | `(input, options) -> JSON` | Match the embedded ruleset: `capabilities` sorted by namespace/name with `hits`, `lib`, `degraded`, `unsupported`, `attack`/`mbc`, and bounded `evidence`; plus `capability_count`, `skipped_count`/`skipped_by_reason`, `unsupported_features`, `scan_truncated`, `budget_exhausted`, `truncated`, `warnings`, `input`/`features`/`ruleset` summaries |
| `capa_features` | `(input, options) -> JSON` | The extracted `FeatureSet`: `formats`/`os`/`arch`, `sections` (name/offset/size/entropy), `libraries`, `imports`, `exports`, `api_features`/`import_features` samples, `strings` stats with a bounded distinct-value sample, `embedded_pe` offsets, `forwarded_export`, `warnings`, `truncated` |
| `capa_ruleset` | `(options) -> JSON` | Ruleset metadata: `commit`, `imported`, `rule_count`/`lib_count`/`degraded_count`/`evaluable_count`/`skipped_count`, `skipped_by_reason`, `namespaces`, `unsupported_feature_kinds`, `exact_byte_patterns`, `parse_errors` |

## Options

```json
{"maxResults": 4096, "includeEvidence": true, "includeSkipped": false, "includeLib": false}
```

- `maxResults` (1–4096): caps the emitted `capabilities` list;
  `capability_count` still reports the true total and
  `results_truncated`/`truncated` flag the cut.
- `includeEvidence` (default true): emit per-rule evidence entries.
- `includeSkipped` (default false): additionally emit the
  `skipped_rules` list (name, reason, unsupported kinds).
- `includeLib` (default false): `lib: true` helper rules still evaluate
  so `match:` references resolve, but stay out of the report; the count
  appears as `lib_matched_count`.
- `capa_features` accepts `maxStrings` (default 256, ceiling 4096) for
  its sample lists; `capa_ruleset` accepts `verbose` for the full rule
  list.

## Hard limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB (`input_too_large`) |
| Options JSON | 4 KiB (`options_too_large`) |
| JSON report output | 4 MiB (`output_too_large`) |
| Matched rules emitted | 4,096 (`results_truncated`) |
| Evidence per rule | 32 entries × 8 locations (`evidence_truncated`) |
| Aggregate evidence | 4,096 entries |
| Decoded rules blob | 16 MiB (`ruleset_decode_failed`) |

Limits apply before allocation or serialization. Consumers run each
call in a fresh worker; the embedded ruleset is decoded and compiled per
call.

## Error codes

`input_too_large`, `options_too_large`, `invalid_options`,
`ruleset_decode_failed`, `output_too_large`, `internal_error`.

## Build and verify

```sh
tools/capa-match/script/import-upstream.sh   # fetch pinned capa-rules (once)
cargo test --manifest-path tools/capa-match/Cargo.toml
wasm-pack build tools/capa-match --target web --release --out-dir pkg
node tools/capa-match/test/verify.mjs tools/capa-match/pkg
node tools/capa-match/script/pack.mjs tools/capa-match/pkg artifact/capa-match-wasm
cd artifact/capa-match-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned in
`.github/workflows/build-capa-match.yml`, which runs the same sequence
on the self-hosted runner and uploads `artifact/capa-match-wasm`. The
build also needs `upstream/goblin` at commit
`cec6e6eba5bdcec78ec79edc80b3a1f44856039a` (the shared vendored checkout
used by `tools/goblin`).

`test/verify.mjs` exercises the real compiled module end to end —
ruleset provenance, stable file-scope rule matches on crafted inputs,
the honesty boundary (skipped function-scope rules never fabricate
matches), every input/options bound, and 200+ malformed-buffer fuzz
cases that must return a schema-versioned envelope without throwing.

## Layout

```text
src/lib.rs       wasm-bindgen boundary, options, limits, report envelopes
src/ast.rs       normalized ruleset AST, constant folding, per-rule unsupported lists
src/eval.rs      memoized evaluator: shared scans, regexes, budgets, count ranges
src/extract.rs   bounded FeatureSet extraction (strings, bytes, PE/ELF/Mach-O)
src/ruledoc.rs   YAML→normalized-AST compiler (build.rs and tests only)
build.rs         compiles upstream/capa-rules *.yml into the embedded blob
test/verify.mjs  real-WASM behavioral checks
script/pack.mjs  Forge artifact packer + SHA256SUMS
script/import-upstream.sh  fetches the pinned capa-rules tree
```

## Provenance

The embedded ruleset is Mandiant capa-rules (Apache-2.0) at commit
`805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5`; the matcher itself is
original Turen code. Runtime dependencies are exact-pinned in
`Cargo.lock`: vendored goblin 0.10.6 (MIT), aho-corasick
(Unlicense OR MIT), regex (MIT OR Apache-2.0), flate2+zlib-rs, sha2
(MIT OR Apache-2.0), serde/serde_json, wasm-bindgen. `serde_norway`
parses rule YAML at build time only and is never linked into the
module. See `SOURCE.json` and `NOTICE`.
