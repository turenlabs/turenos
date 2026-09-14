/* tslint:disable */
/* eslint-disable */

/**
 * Structural comparison of the document's `old` and `new` buffers: identity,
 * sizes, common prefix/suffix, bounded changed-region list with per-region
 * entropy and byte-class hints, hashes, and a similarity score.
 *
 * Input document: `{"old": "<base64>", "new": "<base64>"}`.
 * Options: `maxRegions` (default and ceiling 4096).
 */
export function binary_compare(input: Uint8Array, options_json: string): string;

/**
 * Produce a `bipatch`-format patch that transforms `old` into `new`.
 *
 * Input document: `{"old": "<base64>", "new": "<base64>"}`.
 * Options: `maxOutputBytes` (default and ceiling 128 MiB).
 * Returns the patch bytes; errors throw the shared JSON error envelope.
 */
export function binary_diff(input: Uint8Array, options_json: string): Uint8Array;

/**
 * Apply a `bipatch`-format patch to `old`, returning the new bytes.
 *
 * Input document: `{"old": "<base64>", "patch": "<base64>"}`.
 * Options: `maxOutputBytes` (default and ceiling 128 MiB) and
 * `expectedSha256` (64-hex digest verified against the patched output —
 * `bipatch` patches carry no checksum of their own).
 */
export function binary_patch(input: Uint8Array, options_json: string): Uint8Array;

/**
 * Describe a `bipatch`-format patch: header fields, control-record count,
 * payload totals, implied output size, and old-buffer span touched.
 *
 * Input is the raw patch bytes (no JSON document). Options: none.
 */
export function binary_patch_info(input: Uint8Array, options_json: string): string;

/**
 * Cheaper alignment-aware changed-region report. Equal-size buffers use an
 * exact aligned scan; different-size buffers use a rolling-hash anchor scan
 * that tolerates insertions and deletions.
 *
 * Input document: `{"old": "<base64>", "new": "<base64>"}`.
 * Options: `maxRegions` (default and ceiling 4096).
 */
export function binary_regions(input: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly binary_compare: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly binary_diff: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly binary_patch: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly binary_patch_info: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly binary_regions: (a: number, b: number, c: number, d: number, e: number) => void;
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
