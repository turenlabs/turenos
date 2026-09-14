/* tslint:disable */
/* eslint-disable */

/**
 * Decompress one member of a Microsoft Cabinet and return its bytes
 * base64-encoded inside a bounded JSON object: `{schema_version, file, size,
 * declaredSize, sha256, contentBase64, truncated, compression}`. Folders
 * using `none`, `mszip`, or `lzx` compression decode fully; `quantum`
 * reports `unsupported_compression`, as do files that span cabinet
 * boundaries.
 *
 * Options: `file` (required, exact name from `cab_list`), `maxBytes`
 * (optional) requests a bounded preview of at most that many bytes, always
 * clamped to the ~3 MiB serialized-content ceiling. Members declaring more
 * than 128 MiB are never decompressed (`entry_too_large`).
 */
export function cab_extract(bytes: Uint8Array, options_json: string): string;

/**
 * List the contents of a Microsoft Cabinet (.cab): header fields, folders
 * with compression schemes, and file entries with sizes, offsets, and
 * continuation markers. Never writes to disk.
 *
 * Options: `maxFiles` (default and ceiling 4096).
 */
export function cab_list(bytes: Uint8Array, options_json: string): string;

/**
 * Inspect a Windows Installer (MSI) package: CFB container listing, decoded
 * database tables, embedded binary stream metadata, decoded CustomAction
 * types, sequence ordering, and triage findings.
 *
 * Options: `maxRowsPerTable` (default and ceiling 4096), `maxTables`
 * (default and ceiling 4096), `tableFilter` (exact table-name match to
 * decode only selected tables; repeatable via array is not supported —
 * pass a single string).
 */
export function msi_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Read one embedded stream from an MSI package (or a raw CFB stream path)
 * and return its bytes base64-encoded inside a bounded JSON object:
 * `{schema_version, stream, size, declaredSize, sha256, contentBase64,
 * truncated}`.
 *
 * Options: `stream` (required) — a stream name as reported in the
 * `streams[].name` field of `msi_inspect`, or a raw CFB entry path such as
 * `[5]SummaryInformation` as listed in `cfb.entries[].path`; `maxBytes`
 * (optional) requests a bounded preview of at most that many bytes, always
 * clamped to the ~3 MiB serialized-content ceiling. Streams declared larger
 * than 8 MiB are never read (`stream_too_large`).
 */
export function msi_stream_read(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly cab_extract: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly cab_list: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly msi_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly msi_stream_read: (a: number, b: number, c: number, d: number, e: number) => void;
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
