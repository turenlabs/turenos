/* tslint:disable */
/* eslint-disable */

/**
 * Extract exactly one regular file from a SquashFS image by exact normalized
 * path (leading `/`, no `.`/`..` resolution — parent components are rejected).
 *
 * Returns a JSON report `{path, size, declaredSize, sha256, truncated,
 * contentBase64}`. Extraction never touches a filesystem: the entry is
 * decompressed into memory and returned as base64. `truncated` is true when
 * `maxBytes` clipped the entry. Options: `path` (required), `offset`,
 * `maxBytes` (preview limit; without it an entry whose decoded size does not
 * fit the JSON budget fails `entry_too_large`).
 */
export function squashfs_extract(bytes: Uint8Array, options_json: string): string;

/**
 * List a SquashFS image embedded in `bytes`.
 *
 * Returns a JSON report with superblock metadata (`kind`, `version`,
 * `compression`, `blockSize`, inode/fragment counts, timestamps) and a
 * `entries` array of `{path, type, size, mode, uid, gid, mtime, linkTarget?,
 * deviceNumber?}` sorted by path. Entries are capped at 4096 (`truncated`
 * marks overflow). Options: `offset` (byte offset of the image inside
 * `bytes`, for firmware containers), `pathFilter` (directory-prefix filter),
 * `maxResults` (entry cap override).
 */
export function squashfs_list(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly squashfs_extract: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly squashfs_list: (a: number, b: number, c: number, d: number, e: number) => void;
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
