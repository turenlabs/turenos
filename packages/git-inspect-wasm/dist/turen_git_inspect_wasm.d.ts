/* tslint:disable */
/* eslint-disable */

/**
 * Classify one file's bytes: loose object, packfile, pack index (v1/v2),
 * index (`DIRC`), bundle, or unknown.
 */
export function git_identify(bytes: Uint8Array): string;

/**
 * Inspect a `DIRC` index (v2/v3/v4): version, declared vs parsed entry
 * counts, entries `{path, sha1, mode, stage, times, size}` (bounded by
 * `maxItems`), extension names+sizes, and trailer checksum verification.
 */
export function git_index_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Inflate and decode a loose object (`type SP size NUL content`): structured
 * fields for commit/tag/tree, bounded preview + sha256 for blobs, and the
 * recomputed SHA-1 object id.
 */
export function git_object_decode(bytes: Uint8Array, options_json: string): string;

/**
 * Resolve one pack entry selected by `{index}` or `{offset}`, following
 * ofs-delta/ref-delta chains (depth <= 64, result <= 128 MiB). Returns JSON
 * metadata plus a base64 content preview bounded by `maxPreviewBytes`
 * (<= 64 KiB). For the full object bytes use `git_pack_entry_raw`.
 */
export function git_pack_entry(bytes: Uint8Array, options_json: string): string;

/**
 * Resolve one pack entry like `git_pack_entry` but return the complete
 * object bytes as one bounded byte vector (<= 128 MiB). On failure the
 * promise rejects with the error code string (e.g. `"delta_depth_exceeded"`).
 */
export function git_pack_entry_raw(bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Summarize a packfile: version, declared vs parsed object count, per-entry
 * `{type, offset, size}` list (bounded by `maxItems`), delta-chain counts and
 * max depth, and trailing SHA-1 verification.
 */
export function git_pack_inspect(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly git_identify: (a: number, b: number, c: number) => void;
    readonly git_index_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly git_object_decode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly git_pack_entry: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly git_pack_entry_raw: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly git_pack_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
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
