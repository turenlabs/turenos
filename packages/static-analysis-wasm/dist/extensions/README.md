# Static Analysis WASM

Bounded WebAssembly operations for offline file identification, hashing,
disassembly, archive listing, document parsing, and overlay inspection.

The wrapper accepts bytes plus a typed operation name and returns versioned
JSON. It does not read host paths, execute analyzed code, or write extracted
archive members to disk.

```text
identify_file          hash_digest           entropy_scan
fuzzy_hash             import_hash           disassemble
scan_embedded          detect_packer         list_archive
extract_archive_entry  parse_pdf             parse_ole
office_inspect
parse_exif             parse_certificate     parse_plist
parse_lnk              parse_minidump        demangle_symbol
parse_dotnet           inspect_overlay
function_flow          vba_extract           dotnet_methods
```

## Agent Extension Artifact

The `static-analysis-extensions-wasm` workflow artifact is an overlay for the
existing agent workspace package, not a replacement for its legacy runtime.
Verify `SHA256SUMS.extensions`, then overlay its files without removing the
destination's `package.json` or original `dist/turen_static_analysis_wasm*`
files. This preserves legacy Office inspection while adding
`dist/extensions/turen_static_analysis_wasm.js` and its WASM payload.

Build with pinned Rust 1.97.1 and wasm-pack 0.15.0:

```sh
RUSTUP_TOOLCHAIN=1.97.1 RUSTFLAGS='-C link-arg=--max-memory=268435456' \
  wasm-pack build tools/static-analysis --target web --release --out-dir pkg
cargo +1.97.1 test --locked --manifest-path tools/static-analysis/Cargo.toml
node tools/static-analysis/test/verify.mjs tools/static-analysis/pkg
```

Use a fresh host worker with a 30-second timeout and the enforced 256 MiB
linear-memory maximum. Tests reject a module built without that maximum.

ARM64 disassembly accepts `architecture: "arm64"`. Function flow reports direct
branches/calls and bounded basic blocks, not whole-program xrefs. VBA extraction
returns source bytes with an explicitly lossy UTF-8 preview; .NET inspection
returns MethodDef metadata and bounded raw IL, not high-level decompilation.

Additional archive support covers gzip-tar, ar, cpio, and a bounded plain-header
7z subset using Copy/LZMA/LZMA2. Encoded/encrypted 7z headers, RAR, unsupported
codec/filter graphs, sparse/PAX/GNU tar metadata and special entries fail
explicitly. Extraction returns only selected bytes, never filesystem paths.

`detect_packer` uses a pinned MIT-licensed DIE section-name subset; matches remain
heuristics, not proof of packing or malware. See `LICENSE-DIE` and
`THIRD-PARTY-106.txt`. The local Apache-2.0 sevenz-rust 0.6.1 dependency omits its
upstream unbounded JavaScript codec exports; only the bounded Rust reader is used.
