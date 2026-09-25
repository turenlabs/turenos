# YARA-X target

Rules for `tools/yara-x`, on top of the shared rules in `tools/AGENTS.md`.

- Build official YARA-X `v1.19.0` at commit
  `fe40349ea12c5ccb89aae9f304b979c4fb410f66` with Rust 1.94.0 and wasm-pack
  0.15.0 unless performing an explicit reviewed upgrade.
- Keep `patches/bounded-results.patch` applied and covered by compatibility
  tests. Its limits must run before JavaScript result materialization.
- Preserve ceilings for compiled rules, compiled patterns, returned rules,
  aggregate pattern occurrences, tags, metadata, patterns, and warnings.
- Initialize WebAssembly from explicit bytes and explicitly free compiler,
  rules, and scanner objects in tests and consumers.

The self-hosted workflow is the authoritative YARA-X build and must verify the
normal scanner API plus the pre-serialization result bounds.
