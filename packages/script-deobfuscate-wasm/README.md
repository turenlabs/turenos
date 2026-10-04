# Script Deobfuscate

A bounded, offline, pure-WebAssembly static deobfuscator. JavaScript (`js`) is
the initial language; unsupported languages fail explicitly. The engine does
not execute submitted code or provide filesystem, process, or network access.

The host CLI uses `script-deobfuscate js <input>`; agent input uses typed
`language`, `path`, and options rather than an arbitrary shell command.

## Contract

The WASM export is `deobfuscate(bytes, options_json) -> JSON string`.
Options are `language` (default `js`), `extractPayloads` (default false), and
`assumeStandardBuiltins` (default false). Unknown options fail explicitly.
The latter permits supported intrinsic decoding under an explicit pristine
standard-builtins assumption; known shadowing or reassignment must still stop
the intrinsic rewrite. No option enables execution or relaxes hard limits.

Success is a versioned report with `schema_version: 1`, `language: "js"`,
`input: { bytes, sha256 }`, `code`, `transformations`, `payloads`, `warnings`,
and `truncated`. Transformations carry a kind and original UTF-8 byte `start`
and `end` offsets. Payloads carry a kind, those offsets, `code`, and `sha256`.
All offsets refer to the original input. Errors use
`{ schema_version: 1, error: <stable-code>, message: <bounded-description> }`.

The first version folds closed string concatenations and finite numeric
`+`, `-`, `*`, `/`, and `%` expressions, then prints readable JavaScript.
It preserves lone-surrogate string literals, directive semantics, negative
zero, unsupported expressions, and calls with observable effects.

Opt-in `atob` and `String.fromCharCode` decoding is restricted to isolated,
closed literal contexts. Larger programs, unknown reads/calls, shadowing,
mutations, and prior execution sinks disable intrinsic rewriting. An isolated
`eval(atob("..."))` can recover the argument as evidence without executing it.
General alias/string-table resolution, rotated tables, control-flow
flattening, runtime keys, and execution-based recovery are not implemented.

The report must distinguish static recovery from confirmed execution, retain
unsupported expressions, and never claim complete deobfuscation. Extracted
arguments to potential execution sinks are evidence only, never executed.

## Limits

- Input: 1 MiB; options: 4 KiB; serialized report: 4 MiB.
- Returned code: 2 MiB; aggregate payload text: 256 KiB.
- One recovered value: 64 KiB; transformations: 256; payloads: 128.
- Structural depth: 64; linear memory: 256 MiB; host timeout: 30 seconds.
- One isolated worker per invocation. Host recursion is separate and bounded.

Rust, the parser, decoding, rewriting, and printing compile to
`wasm32-unknown-unknown`. JavaScript glue only initializes the module and
transfers inputs/outputs; it does not perform deobfuscation.
