# stng-core target

Rules for `tools/stng-core`, on top of the shared rules in `tools/AGENTS.md`.

- Build the portable subset derived from stng 1.9.0 at commit
  `5d3c939edb55c7dcf3d5be70cad0648953b80640`.
- Keep filesystem, cache, Rizin/radare2, CLI, Rayon, jemalloc, and process
  integration excluded.
- Apply string-count, value-size, aggregate-output, XOR-key, and XOR-input caps
  while collecting results.
