# Offline security tools

TurenOS includes bounded offline analysis tools for email attachments, binaries, packet captures, Office macros, .NET
assemblies, archives, and packer evidence. The operations and verification below cover the `source-106` security
extensions; [agent tool targets](./targets.md) lists the broader shipped target inventory and proposed native or service
integrations. These tools do not perform live scanning or interactive VM debugging.

## Source-106 capabilities

| Tool                                    | Addition                                                                                                          | Deliberate Limits                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_extract_attachment`              | Decode one selected MIME attachment into an explicitly approved new file, with SHA-256.                           | 32 MiB message, 8 MiB decoded attachment. No source overwrite, execution, or automatic attachment recursion.                                                                                                           |
| `disassemble`                           | ARM64 alongside existing x86/x64 decoding; architecture appears in the inspector.                                 | Selected byte ranges only. ARM64 extension: 4 KiB and 256 instructions.                                                                                                                                                |
| `function_flow`                         | x86/x64 and ARM64 instructions, basic blocks, direct branches/calls, and unresolved indirect transfers.           | Linear decoding of a selected range, not function discovery, global xrefs, or proof of reachability.                                                                                                                   |
| `follow_stream`                         | Reconstruct both directions of one explicit TCP endpoint tuple from an offline capture.                           | Bounded acquisition; reports gaps, conflicting overlaps, unsupported packets, and truncation. Never claims an entire capture is complete. No live capture or TLS decryption.                                           |
| `vba_extract`                           | Extract module source from OLE or OOXML VBA projects.                                                             | Bounded source, exact source bytes plus a potentially lossy text preview. No p-code decoding or macro execution.                                                                                                       |
| `dotnet_methods`                        | Enumerate actual MethodDef records and inspect tiny/fat method raw IL.                                            | Not C# decompilation; exception sections and full semantic IL decoding are not provided.                                                                                                                               |
| `list_archive`, `extract_archive_entry` | Add gzip-tar, regular ar, cpio, and a bounded 7z subset to ZIP/tar.                                               | 7z supports plain headers and single-codec Copy/LZMA/LZMA2, including solid streams. Encoded/encrypted headers, complex filter graphs, RAR, bzip2, and xz fail explicitly. Archive paths are never extracted directly. |
| `detect_packer`                         | Eight reviewed DIE PE-section heuristic families with rule provenance and section evidence, plus literal markers. | Heuristics are not proof of packing or malware. No packer version inferred; no additional dynamic unpackers.                                                                                                           |

## Runtime Boundaries

File tools use the existing Location and permission boundaries. Attachment
extraction uses exclusive file creation after source and destination approval.
No analyzed executable, document, script, or macro is run.

These static analyzers run in a fresh worker with the existing timeout and a
verified maximum WebAssembly linear memory of 256 MiB. Archive expansion is
limited to 64 MiB, with at most 4 MiB JSON output. JSON transport can reduce the
effective selected-member limit below the nominal 8 MiB extraction cap.
The gzip-tar extension accepts regular files/directories and rejects sparse,
PAX/GNU metadata extensions and special member types rather than interpreting
them as ordinary files.

The existing static-analysis artifact is retained for existing parsers, including
Office inspection and ZIP/tar handling. The extension artifact is packaged under
`static-analysis/dist/extensions`; source inspection found that the upstream
source snapshot did not reproduce every operation in the previously shipped
artifact, so replacing it wholesale would risk regressions.

## Verification

Modified crate sources and locked dependencies are included in
`packages/email-security-wasm/source-106` and
`packages/static-analysis-wasm/source-106`. Provenance is recorded in
`SOURCE-106.json`; `SHA256SUMS` covers the imported package contents. The local
sevenz-rust patch removes its unbounded upstream JavaScript codec bindings;
only the bounded Rust reader is called. Dependency notices and the MIT DIE
license are included with the static-analysis package.

Rebuild the extension with its required memory boundary:

```sh
RUSTFLAGS='-C link-arg=--max-memory=268435456' bunx wasm-pack@0.15.0 build packages/static-analysis-wasm/source-106 --target web --release
```

Native parser regressions can be run with:

```sh
cargo test --manifest-path packages/static-analysis-wasm/source-106/Cargo.toml
```

The desktop build runs `verify-security-extensions-artifact.ts` against the
actual bundled workers and assets. It checks ARM64 decoding, control flow,
packer evidence, archive listing, attachment bytes, and the WASM memory maximum.
This supplements source tests; it does not replace platform signing, notarization,
or release publication checks.

## Related pages

- [Agent tool targets](./targets.md): the implementation boundary for every candidate agent tool: shipped WASM targets,
  planned replacements, native and service integrations, and required limits.

## Source

- [`packages/core/src/tool/static-analysis-tools.ts`](../../../packages/core/src/tool/static-analysis-tools.ts)
- [`packages/core/src/tool/static-analysis-worker.ts`](../../../packages/core/src/tool/static-analysis-worker.ts)
- [`packages/core/src/tool/email-security-tools.ts`](../../../packages/core/src/tool/email-security-tools.ts)
- [`packages/core/src/tool/follow-stream.ts`](../../../packages/core/src/tool/follow-stream.ts)
- [`packages/static-analysis-wasm/source-106`](../../../packages/static-analysis-wasm/source-106)
- [`packages/email-security-wasm/source-106`](../../../packages/email-security-wasm/source-106)
- [`packages/desktop/scripts/verify-security-extensions-artifact.ts`](../../../packages/desktop/scripts/verify-security-extensions-artifact.ts)
