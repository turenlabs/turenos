# turen-firmware-formats-wasm

Bounded decoders for embedded and firmware file formats for Turen agent
tooling, compiled to WebAssembly with wasm-bindgen. The module is
deterministic, offline, and pure Rust: no filesystem, network, subprocess,
environment, or clock access, and no execution of analyzed code. All parsers
are original implementations written against the public format
specifications. Malformed or hostile input returns structured JSON errors and
never panics.

This target pairs with `binwalk-scan` (which identifies these formats inside
firmware images) and `squashfs` (which extracts filesystems they carry).

## Operations

JSON-report operations return a `String` of JSON. Byte-producing operations
return one `Uint8Array`. Every expected error throws a `JsError` whose
message is a JSON object:

```json
{ "schema_version": 1, "error": "bad_magic", "detail": "..." }
```

All report documents start with `"schema_version": 1`. Addresses are rendered
as `0x…` hex strings, counts and small sizes as JSON numbers, and quantities
that can exceed 2^53 (sparse `expanded_bytes`, chunk `output_bytes`) as
decimal strings.

### `dtb_decompile(bytes, options_json)` -> JSON

Decompiles a flattened device tree (DTB, magic `0xd00dfeed`) to DTS text.
Walks the structure block (`FDT_BEGIN_NODE`/`FDT_PROP`/`FDT_END_NODE`),
resolves property names through the strings block, and reports the memory
reserve map. Property payloads are typed-decoded like `dtc -I dtb`:

- empty payload → `name;`
- printable NUL-terminated data → `name = "s1"[, "s2"];`
- length % 4 == 0 → `name = <0x… 0x…>;` cell array
- otherwise → `name = [xx xx …];` byte array

Report: `{kind:"dtb", version, last_comp_version, boot_cpuid_phys,
total_size, memory_reservations, node_count, property_count, dts, dts_bytes,
truncated, warnings}`. The `dts` field is charged against the serialized
budget; hitting it (or `maxNodes`, or depth 256) sets `truncated`.

Options: `maxOutputBytes` (default ~4 MiB minus envelope), `maxNodes`
(default 65,536).

### `uimage_inspect(bytes, options_json)` -> JSON

Decodes the 64-byte big-endian legacy U-Boot uImage header (magic
`0x27051956`): `name`, `timestamp`, `load_address`, `entry_point`,
`data_size`, and `os`/`arch`/`image_type`/`compression` enums decoded to
names (`linux`/`arm`/`kernel`/`gzip`, …). Verifies the header CRC32 (computed
with the CRC field zeroed) and the data CRC32 over the payload at offset 64.
A header whose declared data extends past the input reports
`data_present:false` and `data_crc.valid:null` rather than failing.

### `uboot_env_parse(bytes, options_json)` -> JSON

Parses a U-Boot environment blob: stored CRC32 followed by NUL-separated
`key=value` strings terminated by an empty string. Reports `crc`
(`stored_le`, `stored_be`, `computed`, `valid`, `endianness` — the stored CRC
is matched against both byte orders), `redundancy` (`none`/`redundant`),
`flag`, `data_offset`, `entries` (`{key, value}`; `value` is `null` for
valueless keys), `terminated`, and `truncated`.

Options: `redundant` — `true` forces the redundant layout (flag byte at
offset 4, data at 5), `false` forces plain, and omitting it auto-detects by
trying the CRC both ways. `maxEntries` caps the entry list (<= 4096). The
CRC in the redundant layout covers the data region only, per U-Boot.

### `ihex_parse` / `srec_parse` -> JSON

Intel HEX (`:LLAAAATT<data>CC`) and Motorola S-Record (`S<type><count><addr>
<data><cksum>`) record listings plus a merged address map:

- `records` — per-record `{index, offset, line, type, record_type, address,
  byte_count, checksum_valid}`; bad checksums flag the record instead of
  aborting the listing.
- `ranges` — merged `[start, end)` data extents; `gaps` — the space between
  consecutive ranges (the segment-layout signal).
- `data_bytes` vs `image_bytes` expose overlapping records.
- ihex: `eof`, `start_address`/`start_address_kind` (types 03/05), extended
  segment (02) and extended linear (04) base records are decoded.
- srec: `header` (S0 text), `count_check` (S5/S6 declared vs actual data
  record count), `start_address` (S7/S8/S9).

Any non-conforming line is an `invalid_record` error naming `line` and
`offset`. Options: `maxRecords` (<= 4096).

### `ihex_flatten` / `srec_flatten` -> bytes

Merge the data records into one contiguous image covering
`[min_address, max_address]` — the base is `min_address` from the parse
report. **Gaps are filled with 0xFF** (the erased-flash convention) by
default; `fill` selects a different byte. Later records overwrite earlier
ones on overlap. Flattening is strict: a malformed line is `invalid_record`
and any bad checksum is `checksum_mismatch`, unless `ignoreChecksums:true`.
A file with no data records produces an empty image.

Options: `fill` (0–255, default 255), `ignoreChecksums` (bool),
`maxOutputBytes` (<= 128 MiB).

### `android_sparse_parse` / `android_sparse_expand`

Android sparse image (magic `0xed26ff3a`, v1.x only): `parse` reports
`version`, `block_size`, `total_blocks`, the chunk table
(`{type:"raw"|"fill"|"dont_care"|"crc32", output_blocks, output_bytes,
total_size, data_size}`), `expanded_bytes`, `image_checksum`, and `crc`
(`stored`, `valid`, `count`). When a CRC32 chunk is present and the expanded
image fits the transform cap, the image is expanded in memory and verified —
set `verifyCrc:false` to skip. A block-count mismatch against `total_blocks`
is a warning, not an error.

`expand` returns the raw output image: `raw` chunks copy payload, `fill`
chunks tile their fill pattern (4-byte AOSP pattern or any longer buffer),
`dont_care` chunks emit `0x00`, and a trailing CRC32 chunk is verified
(`crc_mismatch` on failure). `maxOutputBytes` caps the expansion at
<= 128 MiB, checked before allocation.

## Hard limits

| resource | limit |
| --- | --- |
| input bytes | 32 MiB (`input_too_large`) |
| options JSON | 4 KiB (`options_too_large`) |
| JSON output | 4 MiB (`output_too_large`) |
| list items | 4,096 (records, chunks, entries, ranges, gaps) |
| flatten/expand output | 128 MiB (`output_too_large`, checked pre-allocation) |
| DTB nodes / depth | 65,536 / 256 (`truncated`) |

Limits are enforced before allocation and serialization. Transforms never
return partial output.

## Error codes

`input_too_large`, `options_too_large`, `invalid_options`,
`output_too_large`, `bad_magic`, `truncated`, `malformed`,
`invalid_record`, `unknown_chunk`, `unsupported_version`,
`checksum_mismatch`, `crc_mismatch`, `internal`, `internal_panic`.

## Build, test, package

```sh
cargo test --manifest-path tools/firmware-formats/Cargo.toml
wasm-pack build tools/firmware-formats --target web --release --out-dir pkg
node tools/firmware-formats/test/verify.mjs tools/firmware-formats/pkg
node tools/firmware-formats/script/pack.mjs tools/firmware-formats/pkg artifact/firmware-formats-wasm
node tools/firmware-formats/test/verify.mjs artifact/firmware-formats-wasm/dist
cd artifact/firmware-formats-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned in
`.github/workflows/build-firmware-formats.yml`, which runs the same sequence
on the self-hosted runner and uploads `artifact/firmware-formats-wasm`.

## Layout

```text
src/lib.rs       wasm-bindgen boundary, options parsing, limits, error JSON
src/crc32.rs     CRC-32 (IEEE 802.3) for uImage, env, and sparse checksums
src/dtb.rs       flattened device tree -> DTS decompiler
src/uimage.rs    uImage header + U-Boot environment blob
src/ihex.rs      Intel HEX listing + flatten
src/srec.rs      Motorola S-Record listing + flatten
src/sparse.rs    Android sparse image table + expand
src/tests.rs     unit tests; all fixtures fabricated in test code
test/verify.mjs  real-WASM behavioral checks
script/pack.mjs  Forge artifact packer + SHA256SUMS
```
