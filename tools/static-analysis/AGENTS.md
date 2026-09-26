# Static analysis target

Rules for `tools/static-analysis`, on top of the shared rules in `tools/AGENTS.md`.

- Build `tools/static-analysis` with wasm-pack. The public ABI is
  `analyze(operation, bytes, options_json) -> JSON`.
- Keep operations byte-only. Archive extraction returns one selected entry to
  the host; WASM never writes paths.
- `office_inspect` rejects overlapping/encrypted ZIPs for inspection, caps
  XML/CFB reads and findings, rejects DTD declarations, and reports external
  relationships without dereferencing them.
- Embedded scanning, packer detection, ZIP/tar listing, and overlay inspection
  are the first-cut replacements for Binwalk, DIE, and libarchive. Do not
  bundle Qt, a JavaScript engine, or full 7-Zip.
