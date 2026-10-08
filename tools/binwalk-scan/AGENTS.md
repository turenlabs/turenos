# Binwalk scan target

Rules for `tools/binwalk-scan`, on top of the shared rules in `tools/AGENTS.md`.

- Build `tools/binwalk-scan` directly for `wasm32-unknown-unknown`; keep the raw
  ABI and handwritten ESM loader dependency-free so its shipped closure remains
  MIT/Apache-2.0 only.
- Keep scanning linear, read-only, and non-recursive. Do not add extraction,
  decompression, filesystem, subprocess, network, or analyzed-code execution.
- Preserve the 32 MiB input, 1,000,000 candidate, 4,096 finding, and 4 MiB JSON
  hard limits and the explicit unknown-size semantics for stream signatures.
