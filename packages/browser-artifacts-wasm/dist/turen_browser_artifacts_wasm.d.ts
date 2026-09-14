/* tslint:disable */
/* eslint-disable */

/**
 * Auto-detect the artifact kind and run the matching parser. Detection
 * order per README: `cook` magic, simple-cache magics, sstable footer
 * magic, then a CRC-verified LevelDB log probe. Unrecognized input yields
 * `{"schema_version":1,"error":"unknown_artifact"}`.
 *
 * Options: same as the resolved operation.
 */
export function analyze(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one Chromium simple-disk-cache entry file: `SimpleFileHeader`
 * (initial magic, version, key length, key hash), the stored key (usually
 * a URL) verified against `key_hash` (SuperFastHash) and the optional
 * pre-EOF key SHA-256, the combined stream-1/stream-0 layout resolved via
 * the stream-0 `stream_size`, IEEE CRC-32 verification of each stream
 * when `FLAG_HAS_CRC32` is set, sparse-range headers
 * (`kSimpleSparseRangeMagicNumber`) identified and walked, and a
 * best-effort `HttpResponseInfo` pickle decode of stream 0 yielding
 * request/response/original-response times plus the NUL-separated raw
 * response headers. The on-disk entry format itself stores no per-file
 * timestamps; entry times come from the stream-0 response-info pickle.
 *
 * Options: `max_results` (cap 4096, default 256 — bounds headers and
 * sparse ranges).
 */
export function chrome_cache_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one Chromium LevelDB write log (`.log`, the journal format behind
 * Local Storage, Session Storage, and IndexedDB). Physical records are
 * framed in 32 KiB blocks as FULL/FIRST/MIDDLE/LAST fragments with a
 * masked CRC-32C verified per record (`verify_crc`, default true) and
 * reassembled into logical records; each logical record decodes as a
 * WriteBatch whose entries surface as `{index, log_offset,
 * batch_sequence, sequence, operation, key, value}` rows — tombstones
 * report `operation: "delete"`, non-WriteBatch payloads (e.g. MANIFEST
 * VersionEdits) report `"unparsed"`. Corrupt records are flagged and the
 * remainder of their block skipped per LevelDB resync semantics; the file
 * never fails mid-parse.
 *
 * Options: `max_results` (cap 4096, default 256), `verify_crc`
 * (default true).
 */
export function leveldb_log_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one Chromium LevelDB table (`.ldb`/`.sst`): the 48-byte footer
 * (metaindex + index block handles, magic `0xdb4775248b80fb57`), the
 * metaindex and index blocks, then every referenced data block decoded
 * with shared-prefix restart-array entry decompression. Snappy
 * (`snap`, raw format) blocks are decompressed with the declared length
 * checked against a 64 MiB cap before allocation; each block's CRC-32C is
 * verified when `verify_crc` is set and reported per block. Internal keys
 * decode to `{sequence, operation, user_key}` — tombstones surface as
 * `"delete"`.
 *
 * Options: `max_results` (cap 4096, default 256), `verify_crc`
 * (default true), `include_index` (also list index-block entries,
 * default false).
 */
export function leveldb_table_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one `Cookies.binarycookies` jar: `"cook"` magic, big-endian page
 * table, little-endian page/cookie records. Each cookie decodes to
 * `{page, index, domain, path, name, secure, http_only, flags,
 * expires_unix, created_unix, value, comment}` with the value as a
 * bounded preview (512 UTF-8 chars + 64 hex bytes + SHA-256) and
 * Cocoa-epoch timestamps converted to Unix seconds. The trailing
 * checksum, footer magic, and optional bplist metadata are reported.
 *
 * Options: `max_results` (cap 4096, default 256).
 */
export function safari_cookies_parse(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly analyze: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly chrome_cache_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leveldb_log_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leveldb_table_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly safari_cookies_parse: (a: number, b: number, c: number, d: number, e: number) => void;
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
