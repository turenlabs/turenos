# Agent tool targets

This document records the implementation boundary for candidate Turen agent
tools. `wasm-tools` is for deterministic, bounded byte processing. Programs
that need host networking, packet capture, process debugging, a JVM, or broad
filesystem authority belong behind typed native or service integrations.

## Shipped

`tools/static-analysis` exposes twenty-four bounded operations through
`analyze(operation, bytes, options_json)`. `office_inspect` reports OOXML
parts/relationships and OLE stream metadata plus macro, ActiveX, DDE, and
external-link evidence without opening external targets or executing content.

`tools/protocol-inspect` exposes `inspect(packet_bytes, link_type, options_json)`
for one packet selected from an offline PCAP/PCAPNG capture. It parses bounded
Ethernet, Linux cooked, or raw-IP packets and passive DNS, HTTP, and TLS record
metadata; it does not capture live traffic, resolve names, decrypt TLS, or
return packet payloads beyond a short unknown-protocol prefix.

`tools/binwalk-scan` exposes a dependency-free, scan-only firmware signature
catalog covering common filesystems, boot containers, device trees, and raw
compression streams. It does not extract, decompress, recurse, or execute
input, and unknown stream lengths remain explicitly unknown.

The 1.0.6 extension adds ARM64 decoding, selected-function control flow, VBA
source extraction, .NET methods/raw IL, bounded archive formats, and a reviewed
DIE signature subset. Its workflow artifact overlays `dist/extensions` without
replacing the agent's legacy static-analysis runtime. Email attachment byte
extraction is a separate bounded export in `tools/email-security`; TCP stream
reconstruction is implemented in the host agent over its existing libpcap runtime.

Three forensic agent tools replace the earlier one-crate-per-function wrappers:

- `tools/wifi-offline` summarizes an 802.11 PCAP or radiotap capture.
- `tools/windows-artifacts` parses Prefetch, EVTX, MFT, Amcache, LNK, jump
  lists, and registry hives.
- `tools/rebuild-timeline` merges bodyfile MAC times with those artifact events.

Live WiFi capture, handshake cracking, and host registry writes stay out of WASM.

`tools/monodis` exposes `monodis_disassemble(bytes, options_json)` for one
.NET assembly: default round-trippable IL disassembly or a single metadata
table dump. It reads only the supplied bytes; referenced assemblies are
unavailable by design, so unresolvable references render as explicit
`<BROKEN CLASS ...>` / warning markers and skipped bodies carry a
`// WARNING: method body not decoded` comment. Malformed input fails closed
with `Error: ...` text. The analyzed assembly is never executed.

## Deeper Replacements

| Capability       | Implementation                  | Boundary                                                                   |
| ---------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Broader archives | Minimal libarchive read build   | Keep `list_archive` / `extract_archive_entry`; never extract paths to disk |
| Packer database  | Reviewed declarative DIE subset | Replace marker matching; do not bundle Qt                                  |

Full 7-Zip is not used because its LGPL and restricted RAR components do not
fit a permissive WASM artifact.

## Second Wave

The 1.0.7 batch adds eighteen general-purpose bounded targets, all built with
the pinned Rust/wasm-pack toolchain and the shared byte-in/JSON-out ABI:

- `tools/codec`: decompress/compress (flate2, brotli, lz4_flex, bzip2-rs,
  lzma-rs, ruzstd) and base-N/quoted-printable/uudecode transforms. Pure-Rust
  compressors only; zstd and bzip2 are decode-only.
- `tools/fuzzy-hash`: md5/sha1/sha2/blake3/xxh64 digests, ssdeep-compatible
  CTPH (fuzzyhash), TLSH (tlsh2), and PE imphash (goblin).
- `tools/code-signing`: parse-only X.509, PKCS#7/CMS, CRL, PE Authenticode,
  and Mach-O code-signing superblob inspection. No chain validation, OCSP,
  CRL fetch, or timestamp verification.
- `tools/json-query`: jaq-core/jaq-json queries over bounded input plus
  validation, shape stats, and leaf-path discovery. Hostile filter builtins
  (`env`, `now`, `halt`) are rejected at compile time.
- `tools/pdf-inspect`: lopdf structure/object/stream/text inspection with
  exploit-document findings; encrypted files are reported, never decrypted.
- `tools/minidump`: rust-minidump stream/thread/module/memory reads with
  wrapper-side hostile-RVA neutralization.
- `tools/image-inspect`: PNG/JPEG/GIF/WebP/BMP/TIFF/ICO/AVIF structure, EXIF,
  text chunks, and bounded pixel statistics.
- `tools/crypto-markers`: crypto constant tables (public specifications),
  entropy maps, XOR key probing, byte statistics.
- `tools/squashfs`: vendored backhand SquashFS list/extract; pure-Rust
  compressor closure only — xz/zstd/lzo report explicit unsupported codes.
- `tools/apk-dex`: hand-rolled AXML/DEX parsers plus APK container and
  signing-block analysis.
- `tools/java-inspect`: hand-rolled .class parser with javap-style
  disassembly and JAR/manifest inspection.
- `tools/unicode-audit`: chardetng/encoding_rs detect+transcode and
  Trojan-Source bidi/invisible/mixed-script auditing.
- `tools/installer-inspect`: cfb/msi/cab/lzxd MSI table decode, OLE stream
  reads, and Cabinet listing/extraction.
- `tools/git-inspect`: hand-rolled loose-object, pack/delta, pack-index, and
  DIRC parsing; no repository or git binary required.
- `tools/sourcemap`: rust-sourcemap decode/lookup/reverse-lookup, embedded
  source extraction, index-map flattening.
- `tools/wasm-toolkit`: Bytecode Alliance wat/wasmparser/wasmprinter —
  deeper complement to `wasm-inspect`.
- `tools/macos-artifacts`: plist, FSEvents, tracev3 (uuidtext/dsc strings
  report explicit missing-message markers), and .DS_Store.
- `tools/firmware-formats`: hand-rolled DTB decompile, uImage/u-boot env,
  Intel HEX/S-Record, and Android sparse parse/expand.
- `tools/binary-diff`: hand-rolled bipatch-format binary diff/patch plus
  compare/regions/patch-info reports over a two-buffer JSON document ABI.
- `tools/browser-artifacts`: hand-rolled Chromium LevelDB log/sstable,
  Simple Cache, and Safari binarycookies parsing; read-only forensics.
- `tools/sqlite-inspect`: hand-rolled read-only SQLite 3 file forensics —
  header/schema/b-tree/rows/freelist plus heuristic deleted-record carving.
  No WAL replay, no writes, no C dependency.
- `tools/capa-match`: static-subset capa capability detection — the pinned
  mandiant/capa-rules ruleset compiled at build time and evaluated over
  string/byte/import/section/format features only. Function/basic-block/call
  scope rules are reported as unsupported (a lower bound), never matched.
- `tools/rtf-inspect`: hand-rolled RTF tokenizer/parser — group tree,
  control-word histogram, \objdata embedded-object inventory with OLE magic
  detection, exploit-doc audit flags, bounded text extraction.

## Native And Service Integrations

| Tool      | Decision                                                                                                                                                                                           | Typed operations                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OWASP ZAP | Pin the official container by digest and expose it as an isolated service. Bind its API to loopback, require an API key, run non-root, and restrict network reachability to the authorized target. | `zap_baseline_scan`, `zap_active_scan`, `zap_scan_status`, `zap_alerts`, `zap_report`                                               |
| TShark    | Optional native sidecar for offline pcap/pcapng only. Disable plugins, Lua, extcap, and name resolution; use a fresh config directory.                                                             | `pcap_summary`, `pcap_fields`, `protocol_hierarchy`, `conversations`, `follow_stream`                                               |
| dumpcap   | Separate narrowly privileged helper only if live capture is added. Never run TShark as root.                                                                                                       | `capture_start` with approved interface, required BPF filter, snap length, packet, time, and byte limits                            |
| tcpdump   | Native fallback when TShark is unavailable, not a WASM target. Prefer writing a bounded pcap for later analysis.                                                                                   | `capture_headers`, `offline_decode`                                                                                                 |
| Nmap      | Do not bundle without OEM and legal review of the Nmap Public Source License. A future bring-your-own installation adapter may use unprivileged TCP connect scans only.                            | `tcp_inventory`, `service_fingerprint`, `scan_status` with controller-built argv and parsed XML                                     |
| x64dbg    | Windows VM service only. The debugger must never attach to TurenOS host processes. Destroy the VM on timeout.                                                                                      | `debug_launch`, `debug_attach`, `breakpoint_set`, `step`, `read_registers`, `read_memory`, `trace_record`, `detach`, `export_trace` |
| netcat    | Do not expose the binary or an arbitrary byte-stream command. Implement a purpose-built outbound socket probe instead.                                                                             | `tcp_connect`, `banner_read`, `tls_handshake`, and optionally a fixed-payload bounded `udp_exchange`                                |

ZAP is Apache-2.0. x64dbg is a modified GPLv3 work and depends on Windows
debug APIs, so it is neither a WASM target nor an in-process dependency. Nmap
uses the custom NPSL and its Windows builds include Npcap redistribution
constraints. TShark/Wireshark is GPLv2. tcpdump and OpenBSD `nc` are
permissively licensed, but their live socket and capture authority still makes
native execution the correct boundary.

## Required Limits

Static tools use these default hard ceilings unless a narrower tool-specific
limit applies:

```text
input bytes            32 MiB
JSON output             4 MiB
results                 4,096
one transformed output 128 MiB
host recursion depth        4
worker wall time           60 s
```

Transforms return one byte vector. Archive and carving operations list entries
first and fetch one entry at a time. Recursion is host-controlled with hashing,
deduplication, aggregate expansion limits, and a fresh worker for each input.
No WASM target executes analyzed machine code.

## Primary Sources

- YARA-X: <https://github.com/VirusTotal/yara-x>
- Binwalk: <https://github.com/ReFirmLabs/binwalk>
- Goblin: <https://github.com/m4b/goblin>
- libarchive: <https://github.com/libarchive/libarchive>
- RetDec unpackers: <https://github.com/avast/retdec/tree/master/src/unpackertool/plugins>
- Detect It Easy: <https://github.com/horsicq/Detect-It-Easy>
- OWASP ZAP: <https://github.com/zaproxy/zaproxy>
- x64dbg: <https://github.com/x64dbg/x64dbg>
- Nmap: <https://github.com/nmap/nmap>
- Wireshark: <https://github.com/wireshark/wireshark>
- tcpdump: <https://github.com/the-tcpdump-group/tcpdump>
- OpenBSD netcat: <https://github.com/openbsd/src/tree/master/usr.bin/nc>
