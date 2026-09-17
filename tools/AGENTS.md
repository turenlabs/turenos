# Turen WASM Tools Contributor Guide

This directory produces reproducible, bounded WebAssembly runtimes for Turen
agent tools. Keep build provenance, licensing, runtime isolation, and artifact
bounds as first-class product requirements.

## Directory Layout

This directory is the former `turenio/wasm-tools` repository inside the Forge
monorepo. It contains only shared documentation and tool directories:

```text
../.github/workflows/build-<target>.yml  Trusted reproducible builds
docs/                                    Cross-tool decisions and target research
<target>/                                One self-contained tool target
AGENTS.md                                Contributor and agent instructions
README.md                                Overview
```

Do not put target source, processor data, generated objects, test binaries, or
package artifacts loose in this directory. Each target owns its source, build
scripts, patches, tests, licenses, provenance, and generated output under
`tools/<target>/`.

Current implemented targets:

- `tools/ghidra-decompiler`: Ghidra's standalone C++ decompiler compiled with
  Emscripten and exposed through a narrow memory-backed ABI.
- `tools/yara-x`: official YARA-X Rust WebAssembly bindings with maintained
  pre-serialization limits for agent use.
- `tools/goblin`: bounded executable and archive metadata inspection.
- `tools/stng-core`: portable raw, wide, decoded, classified, and XOR string
  recovery derived from stng.
- `tools/libpcap`: official tcpdump-group libpcap configured for memory-backed
  offline PCAP and PCAPNG reading only.
- `tools/static-unpack`: official UPX decompression plus a separate
  RetDec-derived MPRESS PE32 analysis-grade reconstructor.
- `tools/email-security`: bounded RFC 5322/MIME parsing, attachment metadata and byte extraction,
  IOC extraction, and unverified advertised authentication signals.
- `tools/wasm-inspect`: static WebAssembly module/component validation and
  section inspection; never instantiate inspected input.
- `tools/static-analysis`: twenty-four bounded offline operations for
  identification, hashing, disassembly, archive listing, Office OOXML/OLE,
  document parsing, and overlay inspection.
- `tools/protocol-inspect`: bounded offline packet parsing for Ethernet, raw IP,
  Linux cooked capture, DNS, HTTP, and TLS record metadata.
- `tools/binwalk-scan`: dependency-free, scan-only firmware and embedded-format
  identification inspired by Binwalk's catalog; no extraction or decompression.
- `tools/wifi-offline`: offline 802.11 PCAP/radiotap summary (SSID, BSSID,
  clients, deauth, EAPOL present). No live capture or cracking.
- `tools/windows-artifacts`: Prefetch, EVTX, MFT, Amcache, LNK, jump lists,
  and registry hives as typed records.
- `tools/rebuild-timeline`: bodyfile plus artifact JSON into one sorted
  timeline.
- `tools/monodis`: Mono's `monodis` CIL disassembler as an offline
  memory-backed WASM module; only the supplied bytes are read.
- `tools/codec`: bounded decompress/compress and base-N/quoted-printable/
  uudecode transforms (pure-Rust compressors only; zstd/bzip2 decode-only).
- `tools/fuzzy-hash`: cryptographic digests, ssdeep-compatible CTPH, TLSH,
  and PE imphash.
- `tools/code-signing`: parse-only X.509/PKCS#7/CRL/Authenticode/Mach-O
  code-signing inspection; no trust validation or network verification.
- `tools/json-query`: bounded jaq (jq-style) queries plus JSON validation,
  stats, and path discovery.
- `tools/pdf-inspect`: bounded PDF structure/object/stream/text inspection
  with exploit-document findings.
- `tools/minidump`: Windows minidump/Breakpad crash-dump streams, threads,
  modules, and bounded memory reads.
- `tools/image-inspect`: bounded image structure, EXIF, text-chunk, and
  pixel-stat inspection.
- `tools/crypto-markers`: cryptographic constant detection, entropy maps,
  XOR key probing, byte statistics.
- `tools/squashfs`: SquashFS listing and bounded single-entry extraction via
  vendored backhand; pure-Rust compressors only (no xz/zstd/lzo).
- `tools/apk-dex`: Android binary-XML decode, DEX inspection, APK
  container/signing analysis.
- `tools/java-inspect`: Java .class parsing, javap-style disassembly, JAR
  inspection.
- `tools/unicode-audit`: charset detect/transcode plus bidi, invisible-char,
  and mixed-script (Trojan-Source) auditing.
- `tools/installer-inspect`: MSI table decode, OLE stream reads, Cabinet
  list/extract.
- `tools/git-inspect`: offline git loose-object, pack/delta, pack-index,
  and DIRC inspection.
- `tools/sourcemap`: source-map decode/lookup/reverse-lookup/source
  extraction.
- `tools/wasm-toolkit`: wat print/compile, WASM feature detection, and
  producers/component metadata.
- `tools/macos-artifacts`: plist, FSEvents, unified-log tracev3, and
  .DS_Store parsing.
- `tools/firmware-formats`: DTB decompile, uImage/u-boot env, Intel HEX,
  S-Record, Android sparse images.
- `tools/binary-diff`: bipatch-format diff/patch plus compare/regions/
  patch-info; two-buffer JSON document ABI, byte results to the host.
- `tools/browser-artifacts`: Chromium LevelDB log/sstable, Simple Cache,
  and Safari binarycookies parsing; read-only, corruption-tolerant.
- `tools/sqlite-inspect`: read-only SQLite 3 file forensics — header,
  schema, b-tree stats, bounded row decode, freelist, heuristic carving.
  No WAL replay or writes.
- `tools/capa-match`: static-subset capa matcher over the pinned
  capa-rules ruleset (import via `script/import-upstream.sh`; YAML front end
  stays host-side in `serde_norway`, never in the wasm closure). File-scope
  features only; non-file-scope rules report `static-scope-unsupported`
  rather than matching — results are a reported lower bound.
- `tools/rtf-inspect`: hand-rolled RTF parser — structure, \objdata/OLE
  embedded-object inventory, audit flags, bounded text extraction. Payloads
  are reported with hashes and previews, never executed or written to disk.

## Build And Provenance Rules

- Pin every upstream source to an immutable commit and record its repository,
  version, commit, toolchain, maintained patches, and workflow run in the
  packaged artifact.
- Pin compilers, package builders, and GitHub Actions by immutable versions or
  commits. Do not use floating branches, `latest`, or mutable major-version
  Action references.
- Self-hosted workflows may run only for trusted pushes or explicit manual
  dispatches. Never execute pull-request code on a persistent self-hosted
  runner.
- Keep Turen patches small, reviewable, and stored under the owning target.
  Verify that each patch applies cleanly to the pinned upstream commit.
- Produce SHA-256 manifests covering every distributed runtime file. Validate
  the complete manifest before importing an artifact into Forge.
- Preserve upstream license headers and distribute all required `LICENSE`,
  `NOTICE`, attribution, and modification notices with each artifact.
- Do not commit generated object directories, local caches, native test
  binaries, `.DS_Store`, or workflow download directories.
- Forge consumes checked-in workspace packages at `packages/<target>-wasm` so
  normal builds do not need the WASM toolchains. Build workflows pack into
  `packages/<target>-wasm` and open an update PR; locally run
  `bun run build:wasm <target>` from the repository root.

## Runtime Boundary

`wasm-tools` is for deterministic, bounded byte processing. A normal target
accepts bytes plus structured options and returns bounded JSON or one bounded
byte vector.

- Do not expose an upstream CLI, shell command, arbitrary argument list, host
  path, network socket, subprocess, or environment access through a WASM API.
- Do not execute or emulate analyzed machine code in a static WASM target.
- Use a fresh isolated worker when malformed input could poison runtime state.
- Enforce limits before expensive allocation or JavaScript serialization, not
  only after the full upstream result has been materialized.
- Terminate workers on cancellation or timeout and await termination before
  releasing concurrency permits.
- List archive or carving results first and retrieve one entry at a time. WASM
  must never extract untrusted paths to the host filesystem.
- Keep recursion in the host with hashing, deduplication, depth limits, and
  aggregate expansion limits.

Default maximums unless a target defines a narrower limit:

```text
input bytes             32 MiB
JSON output              4 MiB
results                  4,096
one transformed output 128 MiB
host recursion depth         4
worker wall time            60 s
```

## Implemented Targets

### Ghidra Decompiler

- Build from `tools/ghidra-decompiler` with Emscripten 6.0.8.
- Keep BFD-dependent code excluded. Do not introduce the GPL BFD path into the
  distributed module.
- The analyzed program is input data and must never be executed.
- Preserve the memory-backed wrapper ABI and processor asset layout expected
  by Forge unless the Forge consumer is migrated in the same change.
- Verify decompilation through the packaged module and regenerate its checksum
  manifest before distribution.

```sh
cd tools/ghidra-decompiler
npm run build
npm test
npm run pack:forge
```

### YARA-X

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

### Goblin

- Build Goblin 0.10.6 at commit
  `cec6e6eba5bdcec78ec79edc80b3a1f44856039a`.
- Preserve collection and serialized-output limits in the Rust wrapper.
- Keep parsing byte-only and read-only. Do not expose archive extraction or
  Goblin writing APIs.

### stng-core

- Build the portable subset derived from stng 1.9.0 at commit
  `5d3c939edb55c7dcf3d5be70cad0648953b80640`.
- Keep filesystem, cache, Rizin/radare2, CLI, Rayon, jemalloc, and process
  integration excluded.
- Apply string-count, value-size, aggregate-output, XOR-key, and XOR-input caps
  while collecting results.

### libpcap

- Build official tcpdump-group libpcap 1.10.6 at commit
  `a999701dca5c873779281938baee6bc185a8d4dc` with `PCAP_TYPE=null`.
- Expose only memory-backed offline reading and numeric classic BPF filters.
- Do not expose live capture, devices, paths, dumping, callbacks, handles,
  remote capture, or symbolic name-service lookups.

### Static Unpack

- Build official unmodified UPX 5.2.0 at commit
  `034b6d0d81c53998c07ad6f34bfead6f5c5445ce` as a separate Emscripten
  program. It is GPL-2.0-or-later and every distributed package must contain
  `upx-5.2.0-source.tar.gz`; Forge's license audit enforces this.
- Keep MPRESS code separate and derived from MIT RetDec 5.0 commit
  `53e55b4b26e9b843787f0e06d867441e32b1604e`.
- MPRESS output is analysis-grade: it restores decompressed PE32 section data
  and OEP but does not rebuild imports. Preserve `runnable: false` and
  `importsRebuilt: false` until differential tests prove otherwise.
- Never execute analyzed binaries. Standard UPX processing runs the trusted
  UPX program against input bytes in an isolated MEMFS worker.

### Static Analysis

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

### Protocol Inspect

- Build `tools/protocol-inspect` with wasm-pack. Its public ABI is
  `inspect(packet_bytes, link_type, options_json) -> JSON`; the packet must be
  selected by a separate offline capture reader.
- Keep link types numeric and do not add sockets, DNS, decryption, or live
  capture APIs. Payload inspection is bounded and passive.

### Binwalk Scan

- Build `tools/binwalk-scan` directly for `wasm32-unknown-unknown`; keep the raw
  ABI and handwritten ESM loader dependency-free so its shipped closure remains
  MIT/Apache-2.0 only.
- Keep scanning linear, read-only, and non-recursive. Do not add extraction,
  decompression, filesystem, subprocess, network, or analyzed-code execution.
- Preserve the 32 MiB input, 1,000,000 candidate, 4,096 finding, and 4 MiB JSON
  hard limits and the explicit unknown-size semantics for stream signatures.

### Monodis

- Build `tools/monodis` with Emscripten 6.0.8 from the pinned Mono commit;
  keep `patches/0001-0004` small, ordered, and re-applicable by
  `script/import-upstream.sh`.
- Keep the module offline and single-input: assembly resolution hooks
  resolve nothing, and referenced assemblies (including mscorlib) stay
  unavailable. Never silently skip method bodies; degradation must render
  as explicit warnings or markers in the output.
- Preserve the narrow `init_monodis` / `monodis_disassemble` / `free_string`
  ABI, the 32 MiB input and 4 MiB output bounds, and the `Error: ...`
  fail-closed contract.
- Ship `NOTICE` attribution plus `LICENSE-MONO` and `PATENTS-MONO`; no GPL
  build-time or C# class-library code may enter the link closure.

## Current Build Targets

These remain open for deeper replacements. Keep the public API typed and
narrower than the upstream application.

| Capability | Preferred implementation | Required boundary |
| --- | --- | --- |
| Broader archives | Minimal libarchive read build | Keep `list_archive` / `extract_archive_entry`; never extract paths to disk |
| Packer database | Reviewed declarative DIE subset | Replace marker matching; do not bundle Qt or its JavaScript engine |

Do not embed full 7-Zip because its LGPL and restricted RAR components do not
fit the target.

## Native And Service-Only Targets

The following tools are not WebAssembly targets. Do not add them to this
repository as embedded binaries or arbitrary command wrappers.

| Tool | Approved integration boundary |
| --- | --- |
| OWASP ZAP | Isolated, digest-pinned, non-root container service with loopback API, API key, and network access restricted to an authorized target. Expose typed scan/status/alert/report operations only. |
| TShark | Optional native sidecar for offline pcap/pcapng analysis. Disable plugins, Lua, extcap, and name resolution; use a fresh config directory and typed operations. |
| dumpcap | Separate narrowly privileged live-capture helper with approved interface, required BPF filter, and packet/time/byte limits. Never run TShark as root. |
| Nmap | Do not bundle without OEM and legal review of the NPSL. A future bring-your-own adapter may initially expose unprivileged TCP connect scans with controller-built argv and parsed XML. |
| x64dbg | Disposable Windows VM service only. Never attach to TurenOS host processes; destroy the VM on timeout and expose typed debugger operations rather than scripts or commands. |
| netcat | Do not expose the binary or an arbitrary byte stream. Implement typed outbound `tcp_connect`, `banner_read`, `tls_handshake`, and optionally fixed-payload bounded `udp_exchange` operations. |

See `docs/targets.md` for licensing details, operation names, and the complete
reasoning behind these boundaries.

## Adding Or Updating A Target

1. Verify the upstream license, transitive runtime licenses, source
   provenance, and WebAssembly feasibility from primary sources.
2. Define the narrow typed operation and hard input, allocation, output,
   concurrency, and wall-clock limits before writing the wrapper.
3. Add a self-contained `tools/<target>` directory with a pinned source lock,
   maintained patches, build scripts, tests, licenses, and README.
4. Add a trusted self-hosted workflow
   (`.github/workflows/build-<target>.yml`) that builds from source, tests the
   real implementation, generates checksums and provenance, packs into
   `packages/<target>-wasm`, and opens an update PR.
5. Differential-test transformations against the same pinned native revision
   where a native implementation exists. Fuzz malformed input for parsers and
   unpackers.
6. Merge only a passing checksum-verified package update PR. Verify source,
   Node, compiled CLI, Desktop bundle, and packaged Desktop paths when the
   runtime ships in all of them.
7. Update this file and `docs/targets.md` when a target changes status or its
   security boundary changes.

## Review Checklist

Before merging, confirm:

- `tools/` still contains no target implementation files outside `tools/<target>/`.
- The upstream commit and toolchains are immutable and recorded.
- No persistent self-hosted workflow executes pull-request code.
- Required licenses and notices ship with the artifact.
- Checksums cover every distributed file and validate successfully.
- Limits apply before unbounded allocation or result serialization.
- Cancellation awaits worker termination and concurrency remains bounded.
- Tests execute the actual WebAssembly implementation, not duplicated logic or
  mocks.
- Forge packaging uses the same verified bytes in source, CLI, and Desktop
  distributions.
