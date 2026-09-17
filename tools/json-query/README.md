# turen-json-query-wasm

Bounded jq-style JSON interrogation for Turen agent tools, built on the
[jaq](https://github.com/01mf02/jaq) library crates — a pure-Rust jq
implementation — compiled to `wasm32-unknown-unknown` with `wasm-bindgen`.

The package lets agents interrogate large JSON blobs without shelling out to
`jq` or another process. Filters come only from the caller's options, never
from the input bytes, and every operation is deterministic and offline: no
filesystem, network, environment, clock, or subprocess access is exposed.

## API

All operations return JSON text. Every success and error document carries
`"schema_version": 1`. Errors are returned as JSON, never traps or throws:

```json
{"schema_version": 1, "error": "<code>", "message": "<detail>"}
```

Error codes: `input_too_large`, `options_too_large`, `options_invalid`,
`missing_filter`, `input_too_deep`, `input_parse_error`, `filter_parse_error`,
`filter_compile_error`, `eval_error`, `halted`, `internal_exception`,
`too_many_input_values`, `output_too_large`.

### `json_query(bytes, options_json) -> string`

Options:

```json
{
  "filter":    "string, required",
  "slurp":     "bool, default false",
  "nullInput": "bool, default false",
  "limit":     "number, default 4096, clamped to 0..4096",
  "rawOutput": "bool, default false"
}
```

Evaluates the jq/jaq filter once per input JSON value.

- Default mode parses the input as a whitespace-separated sequence of JSON
  values (NDJSON-style) and runs the filter on each; `input`/`inputs` inside a
  filter read the remaining documents, matching jq.
- `slurp: true` parses all values, collects them into one array, and runs the
  filter once (jq `-s`). Up to 1,048,576 input values.
- `nullInput: true` runs the filter once on `null` without reading the input
  bytes (jq `-n`).
- `rawOutput: true` renders each result as its jq `-r` text (strings
  unwrapped, other values as compact JSON); entries remain JSON strings so the
  response is still strict JSON, and `"raw": true` is set.
- Results are capped at `limit` (max 4,096) and the serialized response at
  4 MiB. Overflow sets `"truncated": true`, with `"warning"` of
  `"result_too_large"` when a single result exceeds the cap or
  `"output_bytes_limit"` when the aggregate does.

Success:

```json
{"schema_version": 1, "results": [<json>, ...], "truncated": false}
```

Mid-stream failures include the results collected so far:

```json
{"schema_version": 1, "error": "eval_error", "message": "...", "results": [...], "resultCount": 3}
```

Filter parse/compile errors report byte positions in the filter source:

```json
{"schema_version": 1, "error": "filter_parse_error",
 "errors": [{"message": "parse error: ...", "offset": 12, "end": 15}]}
```

`filter_compile_error` is used for unknown or removed filters. `env` and `now`
are deliberately absent — they would expose host environment variables and a
nonexistent wall clock — and `import`/`include`/`halt` resolve to clean JSON
errors instead of filesystem access or process exit.

### `json_validate(bytes) -> string`

Strict RFC 8259 validation plus token statistics:

```json
{"schema_version": 1, "valid": true,
 "stats": {"bytes": 33, "depth": 2, "objectCount": 2, "arrayCount": 1, "scalarCount": 4}}
```

Invalid input returns `"valid": false`, `"error": "invalid_json"`, the serde
`message`, and `line`/`column`. Depth beyond 512 returns `"error":
"depth_exceeded"`. Statistics come from an iterative byte-level pre-pass and
are exact for valid input, best-effort otherwise. Unlike `json_query` (which
accepts the jaq superset — `#` comments, `NaN`, `Infinity`, `+`-numbers,
`b"..."` byte strings), this operation is strict: `NaN`, trailing data, and
trailing commas all fail.

### `json_stats(bytes) -> string`

Top-level shape summary for agent orientation:

```json
{"schema_version": 1, "type": "object", "bytes": 60, "length": 4,
 "keys": ["a", "b"], "keyTypes": {"a": "number"},
 "valueTypes": {"number": 1, "string": 1}, "truncated": false}
```

`type` is one of `null|boolean|number|string|bytes|array|object`. Objects add
`length`, up to 512 `keys`, per-key `keyTypes`, and a `valueTypes` histogram;
arrays add `length` and an `elementTypes` histogram. Deterministic: histograms
and keys are emitted in input order (objects) or sorted (histograms).

### `json_paths(bytes, options_json) -> string`

Enumerates leaf paths (scalars and empty containers) with type tags:

```json
{"schema_version": 1, "paths": [{"path": ".a.b", "type": "number"}], "count": 1, "truncated": false}
```

Options: `{"limit": 0..4096}` (default 4096). Paths use jq notation (`.a.b`,
`.a[0]`, `.["key with spaces"]`); non-string object keys render as their JSON
representation. Long paths are clipped to 4,096 characters.

## Hard limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options bytes | 64 KiB (target override; jq filters can be long) |
| Input JSON depth | 512 containers, enforced by an iterative pre-pass before any recursive parser runs |
| Results / paths | 4,096 |
| Serialized output | 4 MiB |
| Slurp input values | 1,048,576 |
| Reported filter errors | 16 |

All limits apply before unbounded allocation or serialization.

## Runtime boundary and hostile filters

The module performs no I/O, executes nothing, and is deterministic. However,
jaq has no fuel or operation-count limiter: an untrusted filter such as
`def f: f; f` can burn unbounded CPU, memory, or wasm stack inside a single
call. The result/output caps above cannot preempt evaluation. **The host
worker must enforce the 60-second wall-clock bound and a memory bound, and
must terminate the worker on timeout or cancellation** (per AGENTS.md). Input
depth is capped pre-parse so malformed nesting cannot overflow the stack, but
filter recursion remains a host responsibility.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/json-query/Cargo.toml
wasm-pack build tools/json-query --target web --release --out-dir pkg
node tools/json-query/script/pack.mjs tools/json-query/pkg artifact/json-query-wasm
node tools/json-query/test/verify.mjs artifact/json-query-wasm/dist
cd artifact/json-query-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm-opt -Os` via wasm-pack.
Dependencies are exact-pinned in `Cargo.toml` and `Cargo.lock`.

## Provenance and licensing

- Upstream: [jaq](https://github.com/01mf02/jaq) crates `jaq-core 3.1.1`,
  `jaq-json 2.0.3`, `jaq-std 3.0.3`, MIT license (Michael Färber and
  contributors), plus `hifijson 0.5.0` (MIT).
- `serde`/`serde_json` (MIT OR Apache-2.0) for options parsing and strict
  validation; `wasm-bindgen 0.2.127` for the bindings.
- The complete transitive closure is pinned in `Cargo.lock`; all licenses are
  permissive (MIT/Apache-2.0/Zlib/Unicode-3.0/BSL-1.0/Unlicense; `self_cell`
  is elected under Apache-2.0). See `NOTICE` and `SOURCE.json`.
- This wrapper is Apache-2.0 OR MIT (Turen Labs).
