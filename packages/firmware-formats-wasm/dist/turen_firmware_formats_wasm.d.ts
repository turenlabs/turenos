/* tslint:disable */
/* eslint-disable */

/**
 * Expand an Android sparse image to the raw output image.
 *
 * `raw` chunks copy payload bytes, `fill` chunks tile their fill pattern,
 * `dont_care` chunks emit 0x00. A trailing CRC32 chunk is verified against
 * the expanded image (`crc_mismatch` on failure). Options: `maxOutputBytes`
 * (<= 128 MiB).
 */
export function android_sparse_expand(bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Parse an Android sparse image (magic 0xed26ff3a) chunk table.
 *
 * Returns `{kind:"android-sparse", version, block_size, total_blocks,
 * chunk_count, chunks, expanded_bytes, crc:{stored,valid}, ...}`. When a
 * CRC32 chunk is present and the expanded image fits the transform cap, the
 * image is expanded in memory and the CRC verified. Options: `verifyCrc`
 * (default true), `maxChunks` (<= 4096).
 */
export function android_sparse_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Decompile a Flattened Device Tree (DTB) to DTS source text.
 *
 * Returns a JSON report `{kind:"dtb", version, last_comp_version,
 * boot_cpuid_phys, total_size, memory_reservations, node_count,
 * property_count, dts, dts_bytes, truncated, warnings}`. Property values are
 * typed-decoded: printable NUL-terminated data renders as `"string"[, ...]`,
 * 4-aligned data as `<0x...>` cell arrays, everything else as `[xx ...]` byte
 * arrays. Options: `maxOutputBytes` (DTS text budget, default ~4 MiB),
 * `maxNodes` (default 65,536).
 */
export function dtb_decompile(bytes: Uint8Array, options_json: string): string;

/**
 * Flatten Intel HEX data records into one contiguous image.
 *
 * Output covers `[min_address, max_address]` of the data records; gaps are
 * filled with `fill` (default 0xFF, flash convention). The base address is
 * `min_address` from `ihex_parse`. Strict by default: any malformed line or
 * bad checksum is an error; `ignoreChecksums:true` skips checksum enforcement.
 * Options: `fill` (0-255), `ignoreChecksums` (bool), `maxOutputBytes`
 * (<= 128 MiB).
 */
export function ihex_flatten(bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Parse Intel HEX records into a bounded listing plus merged address map.
 *
 * Returns `{kind:"ihex", record_count, records, ranges, gaps, data_bytes,
 * min_address, max_address, eof, start_address, invalid_checksums, ...}`.
 * Gaps between merged ranges are reported explicitly — that is the segment
 * layout signal. Per-record `checksum_valid` flags bad lines without
 * aborting the listing. Options: `maxRecords` (<= 4096).
 */
export function ihex_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Flatten S-Record S1/S2/S3 data records into one contiguous image.
 * Semantics and options are identical to `ihex_flatten`.
 */
export function srec_flatten(bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Parse Motorola S-Record (SREC/S19) lines into a bounded listing plus
 * merged address map. Same shape as `ihex_parse` plus `header` (S0 text) and
 * `count_check` (S5/S6 declared vs actual data record count).
 */
export function srec_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse a U-Boot environment blob (CRC32 + NUL-separated `key=value`).
 *
 * Returns `{kind:"uboot-env", crc:{stored_le, stored_be, computed, valid,
 * endianness}, redundancy, flag, data_offset, entry_count, entries,
 * terminated, truncated, warnings}`. Options: `redundant` (bool; when omitted
 * the layout is auto-detected from the CRC), `maxEntries` (<= 4096).
 */
export function uboot_env_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Inspect a legacy U-Boot uImage (magic 0x27051956) 64-byte header.
 *
 * Returns a JSON report with name, timestamp, load/entry addresses, data
 * size, decoded os/arch/type/compression enums, and both header and data
 * CRC32 verification results. A header whose data extends past the input
 * still reports with `data_present:false` and `data_crc.valid:null`.
 */
export function uimage_inspect(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly android_sparse_expand: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly android_sparse_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dtb_decompile: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly ihex_flatten: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly ihex_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly srec_flatten: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly srec_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly uboot_env_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly uimage_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
