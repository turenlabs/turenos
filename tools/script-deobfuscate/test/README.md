# Verification

Run the actual compiled module, not a native stand-in:

```sh
node tools/script-deobfuscate/test/verify.mjs tools/script-deobfuscate/pkg
node tools/script-deobfuscate/test/verify.mjs packages/script-deobfuscate-wasm/dist
```

The only argument is a trusted artifact directory. The verifier loads explicit
WASM bytes, audits imports and the declared 256 MiB memory maximum, and verifies
packaged runtime checksums before importing glue. It never reads or executes a
submitted sample. WASM is the only deobfuscator implementation in these tests.

## Corpus and oracles

- 320 deterministic seeded fixtures compose escaped strings, concatenation,
  arithmetic, literal array indexing, Latin-1 base64, and UTF-16 fromCharCode.
  Each has a separately generated known value. Baseline concat/arithmetic must
  actually rewrite; mere unchanged output or prettier formatting does not pass.
- Authored safety fixtures cover shadowing/reassignment, closures, mutable and
  escaped tables, getters and trace order, TDZ/switch TDZ, assignment/update
  targets, typeof, directive insertion, ASI, regex/tagged templates, lone
  surrogates, astral UTF-16, rounding/large integers, -0, NaN, infinity, bigint,
  Latin-1 decoding and reference exceptions. Both builtin assumption modes run.
- Only this trusted corpus and its WASM rewrite enter fresh `node:vm` contexts
  with 100 ms timeouts and string/WASM code generation disabled. Oracles compare
  result values, observable trace and error type, preserving -0/NaN/undefined
  and UTF-16 code units. This is a test-only reference, never the engine runtime.
- eval/Function/string-timer programs and extracted text are **never executed**.
  Assertions check opt-in recovery, expected payload text, SHA-256 and original
  UTF-8 evidence spans. Every success checks input SHA-256 and span boundaries;
  optional span hashes are checked when exposed by the report.
- Same-input determinism and second-pass semantic equivalence are checked.
  Second-pass printer differences are recorded, not rejected; counts/spans are
  not expected to stay constant when the input has changed.

## Boundaries and isolation

Fresh workers cover malformed UTF-8, input 1 MiB, options 4 KiB, unknown/wrong
options and language, syntax errors, near-64/deep AST vs deep quoted strings,
transform/value/payload count and size limits, and escaped output expansion.
Every success enforces code 2 MiB, payload total 256 KiB, serialized output
4 MiB, transformations 256, payloads 128, and individual payload 64 KiB.
Structured rejection is acceptable for over-limit expansion; no raw trap or
unstructured exception is accepted. Expected bad-input errors must be stable.
Each worker also checks a positive rewrite after its boundary request to catch
instance poisoning. A separately initialized worker is terminated and joined,
then a fresh replacement is checked. This is an isolation smoke test, not a
claim that host interruption/backpressure integration has been qualified.

The verifier reports wall time and boundary outcomes. Full qualification must
be run by the parent/build runner after compiling WASM; source review alone is
not a passing qualification. Avoid exhaustive combinatorial generation.
