# turen-minidump-wasm

Bounded offline parsing of Windows minidump (`.dmp`, `MDMP`) and Breakpad /
Crashpad crash dumps for Turen agent tools, built on the
[rust-minidump](https://github.com/rust-minidump/rust-minidump) crates and
compiled to `wasm32-unknown-unknown` with `wasm-bindgen`.

The package lets agents inspect crash dumps without running a native
`minidump_stackwalk` or `minidump_dump` process. Every operation is
deterministic, parse-only, and offline: no filesystem, network, environment,
clock, subprocess, or analyzed-code-execution capability is exposed.

## API

All operations accept the dump bytes plus a small JSON options document and
return JSON text. Every success and error document carries
`"schema_version": 1`. Errors are JSON, never traps or throws:

```json
{"schema_version": 1, "error": "<code>", "message": "<detail>"}
```

Error codes: `input_too_large`, `options_too_large`, `options_invalid`,
`too_many_streams`, `parse_failed`, `missing_stream`, `invalid_stream`,
`stream_not_found`, `invalid_address`, `invalid_length`,
`unmapped_address`, `output_too_large`, `serialize_failed`.

### `minidump_inspect(bytes, options_json) -> string`

Options: `{"limit": <usize, default 4096, clamped to 0..4096>}`.

Returns a bounded summary: header signature/version/flags, the full stream
directory (type, vendor, size, bounds, decodability), system info (CPU, OS,
version, CSD string), the exception record (code, address, thread id, crash
reason/address, register context), threads (id, name, stack region, register
context), modules (name, version, base, size, CodeView/PDB identifiers),
unloaded modules, memory regions, memory info or Linux maps, misc info
(process id, timestamps, processor power info, build strings), Breakpad
info, assertion info, Crashpad annotations, macOS crash info/bootargs, and
soft errors. Any RVA sanitization applied before parsing is reported in
`warnings`.

### `minidump_stream(bytes, options_json) -> string`

Options: `{"stream": <u32 | "0x.." | "Name">}` or `{"name": "<StreamName>"}`,
plus `"previewBytes"` (default/capped at 65536).

Decodes exactly one selected stream. Streams with typed support decode to
structured JSON (`"decoded": true`): thread/module/memory lists, exception,
system info, misc info, memory info, thread info, thread names, Breakpad and
Crashpad extensions, Linux streams (cpuinfo, environ, lsb-release,
proc-status, maps, limits, soft-errors), the Chromium stability report, and
the handle-data stream. `HandleDataStream` and `ThreadNamesStream` are
decoded by bounds-checked manual decoders because the upstream handle parser
walks an unbounded `next_info_rva` chain. Streams without a typed decoder
return a bounded base64 preview (`"decoded": false`, `preview_base64`,
`preview_truncated`, `size`).

### `minidump_memory_read(bytes, options_json) -> string`

Options: `{"address": <u64 | "0x..">, "length": <u64 | "0x..">}` where
`0 < length <= 65536`.

Resolves the virtual address through the dump's memory regions
(Memory64List preferred, then MemoryList) and returns base64 bytes, the
serving region, and `coverage: "full" | "partial"`. Unmapped addresses
return `unmapped_address`.

### `minidump_modules(bytes, options_json) -> string`

Options: `{"limit": <usize, default 4096>}`.

Returns module metadata and symbol identifiers — name, code file, base,
size, version, checksum, timestamp, `code_id`, `debug_file`, `debug_id`
(Breakpad format), and the parsed CodeView record (`pdb70`/`pdb20`/`elf`)
— for matching against debug-symbols tool output.

## Limits

```text
input bytes          32 MiB
options JSON          4 KiB
JSON output           4 MiB
stream directory   4,096 entries
list items         4,096
stream preview      64 KiB
memory read         64 KiB
handle chains          64 nodes
annotations           512 per map
strings            4,096 chars
```

## Hardening notes

`minidump` 0.27.0 reads length-prefixed UTF-16 strings with 32-bit `usize`
arithmetic on `wasm32`; a hostile RVA+size pair can wrap the bounds check and
panic. This wrapper locates every string RVA that reaches that reader before
parsing and zeroes hostile fields in a patched copy (reported in
`warnings`). The handle-data stream is decoded by hand so its object-info
linked list is walked with a cycle bound.

## Build

```sh
cargo test --manifest-path tools/minidump/Cargo.toml --locked
wasm-pack build tools/minidump --target web --release --out-dir pkg
node tools/minidump/test/verify.mjs tools/minidump/pkg
node tools/minidump/script/pack.mjs tools/minidump/pkg artifact/minidump-wasm
```

Requires Rust 1.97.1 and wasm-pack 0.15.0; see `SOURCE.json` for provenance.
