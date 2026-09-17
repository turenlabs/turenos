# YARA-X WebAssembly

This target compiles the official YARA-X JavaScript bindings from release
`v1.19.0` at commit `fe40349ea12c5ccb89aae9f304b979c4fb410f66`.

The build uses Rust `1.94.0` and wasm-pack `0.15.0`. A small maintained patch
adds hard aggregate limits while scan results are still Rust iterators, before
serde creates JavaScript objects. The compatibility test requires per-pattern
match limits, explicit WebAssembly initialization from bytes, deterministic
match metadata, and explicit release of WebAssembly heap objects. Forge also
enforces the wall-clock timeout by terminating the isolated worker.

The generated Forge workspace package is uploaded as the `yara-x-wasm`
workflow artifact.
