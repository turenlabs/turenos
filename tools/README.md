# Turen WASM Tools

Reproducible WebAssembly builds used by Turen agent tools. This directory is
the former `turenio/wasm-tools` repository, imported into the Forge monorepo.
Each target builds into its checked-in workspace package at
`packages/<target>-wasm`.

Each target owns its source, build scripts, tests, licenses, and provenance:

- [`tools/ghidra-decompiler`](ghidra-decompiler): Ghidra's standalone
  C++ decompiler exposed through a narrow memory-backed ABI.
- [`tools/yara-x`](yara-x): the official YARA-X Rust WebAssembly API,
  patched with pre-serialization aggregate result limits for agent use.
- [`tools/goblin`](goblin): bounded PE, ELF, Mach-O, TE, COFF, and Unix
  archive metadata inspection built from Goblin.
- [`tools/stng-core`](stng-core): portable bounded raw, wide, decoded,
  classified, and XOR string extraction derived from stng.
- [`tools/libpcap`](libpcap): official tcpdump-group libpcap configured
  for bounded memory-backed offline PCAP and PCAPNG reading only.
- [`tools/static-unpack`](static-unpack): official UPX decompression and
  an analysis-grade RetDec-derived MPRESS PE32 reconstructor.
- [`tools/email-security`](email-security): bounded RFC 5322/MIME
  parsing, attachment metadata and bounded byte extraction, IOC extraction, and advertised authentication
  failure signals.
- [`tools/wasm-inspect`](wasm-inspect): static validation and section
  inspection for WebAssembly modules and components; inspected bytes are never
  instantiated.
- [`tools/static-analysis`](static-analysis): twenty-four bounded offline
  identification, hashing, disassembly, archive, Office, and document operations.
- [`tools/protocol-inspect`](protocol-inspect): bounded offline packet and
  DNS, HTTP, and TLS record inspection for packets selected by libpcap.
- [`tools/binwalk-scan`](binwalk-scan): dependency-free, scan-only
  firmware and embedded-format identification inspired by Binwalk's catalog;
  no extraction or decompression.
- [`tools/wifi-offline`](wifi-offline): offline 802.11 capture summary.
- [`tools/windows-artifacts`](windows-artifacts): Windows forensic
  artifact parser.
- [`tools/rebuild-timeline`](rebuild-timeline): bodyfile plus artifact
  JSON into one sorted timeline.
- [`tools/monodis`](monodis): Mono's `monodis` CIL disassembler as an
  offline memory-backed module; only the supplied assembly bytes are read.
- [`tools/codec`](codec): bounded decompression, compression, and
  text-encoding transforms (gzip/zlib/deflate, brotli, lz4, bzip2, xz/lzma,
  zstd decode; hex/base-N/quoted-printable/uudecode).
- [`tools/fuzzy-hash`](fuzzy-hash): cryptographic digests plus
  ssdeep-compatible CTPH and TLSH similarity hashing and PE imphash.
- [`tools/code-signing`](code-signing): parse-only X.509, PKCS#7/CMS,
  CRL, PE Authenticode, and Mach-O code-signing inspection; no trust
  validation.
- [`tools/json-query`](json-query): bounded jq-style queries via jaq
  plus JSON validation, shape stats, and path discovery.
- [`tools/pdf-inspect`](pdf-inspect): bounded PDF structure, object,
  stream-decode, and text inspection with exploit-document findings.
- [`tools/minidump`](minidump): Windows minidump and Breakpad/Crashpad
  crash-dump parsing: streams, threads, modules, memory reads.
- [`tools/image-inspect`](image-inspect): bounded PNG/JPEG/GIF/WebP/
  BMP/TIFF/ICO/AVIF structure, EXIF, text-chunk, and pixel-stat inspection.
- [`tools/crypto-markers`](crypto-markers): findcrypt-style
  cryptographic constant detection, entropy mapping, XOR key probing, and
  byte statistics.
- [`tools/squashfs`](squashfs): SquashFS v3/v4 listing and bounded
  single-entry extraction via vendored backhand; pure-Rust compressors only.
- [`tools/apk-dex`](apk-dex): Android binary-XML decode, DEX header/
  string/class inspection, and APK container/signing analysis.
- [`tools/java-inspect`](java-inspect): Java .class parsing and
  javap-style disassembly plus JAR/manifest inspection.
- [`tools/unicode-audit`](unicode-audit): charset detection and
  transcode plus Trojan-Source bidi, invisible-character, and mixed-script
  auditing.
- [`tools/installer-inspect`](installer-inspect): MSI compound-file
  table decoding, OLE stream reads, and Cabinet listing/extraction.
- [`tools/git-inspect`](git-inspect): offline git loose-object,
  packfile/delta, pack-index, DIRC index, and bundle inspection.
- [`tools/sourcemap`](sourcemap): source-map decode, lookup,
  reverse-lookup, embedded-source extraction, and index-map flattening.
- [`tools/wasm-toolkit`](wasm-toolkit): deeper WASM analysis on the
  Bytecode Alliance crates — wat printing/compile, feature detection, and
  producers/component metadata.
- [`tools/macos-artifacts`](macos-artifacts): macOS plist, FSEvents,
  unified-log tracev3, and .DS_Store forensic parsing.
- [`tools/firmware-formats`](firmware-formats): DTB decompile, uImage
  and u-boot environment, Intel HEX/S-Record, and Android sparse images.
- [`tools/binary-diff`](binary-diff): bounded binary compare/regions,
  bipatch-format diff production, patch application, and patch introspection.
- [`tools/browser-artifacts`](browser-artifacts): Chromium LevelDB
  log/table, Simple Cache, and Safari binarycookies forensic parsing.
- [`tools/sqlite-inspect`](sqlite-inspect): read-only SQLite 3 database
  forensics — header, schema, b-tree stats, rows, freelist, and heuristic
  deleted-record carving.
- [`tools/capa-match`](capa-match): static-subset capa capability
  matcher — 1,054 embedded Mandiant rules, string/byte/import/section/format
  features; non-file-scope rules report unsupported, never fabricate.
- [`tools/rtf-inspect`](rtf-inspect): RTF structure, embedded-object
  (\objdata/OLE) extraction metadata, exploit-document audit flags, and
  bounded text extraction.

## Build

Rebuild any target locally from the repository root:

```sh
bun run build:wasm <target>     # e.g. bun run build:wasm goblin
bun run build:wasm --list       # list targets
bun run build:wasm --all        # every target (slow)
```

The driver mirrors `.github/workflows/build-<target>.yml`: it builds, runs the
target's verification, and packs into `packages/<target>-wasm`. Requires the
pinned Rust toolchain and wasm-pack (auto-installed via rustup/cargo) or
Emscripten 6.0.8 on PATH for the Emscripten targets.

The self-hosted GitHub Actions workflows build each target from its pinned
toolchain and open a PR updating `packages/<target>-wasm`. They run only for
trusted pushes to `dev` or explicit dispatches, never pull-request code.

See each tool's README and provenance files for source and toolchain details.

See `docs/systems/offline-security-tools/targets.md` for the reviewed WASM, native-sidecar, and service
boundaries for future security tools.
