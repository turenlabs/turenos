/* tslint:disable */
/* eslint-disable */

/**
 * Compare two similarity hash strings. `algorithm` is "ssdeep" or "tlsh".
 * ssdeep reports a 0-100 similarity `score`; TLSH reports a `distance`
 * where 0 is identical and larger values are more different.
 */
export function fuzzy_compare(algorithm: string, hash_a: string, hash_b: string): string;

/**
 * Compute a similarity hash of `bytes` using `algorithm` ("ssdeep" or "tlsh").
 */
export function fuzzy_hash(algorithm: string, bytes: Uint8Array): string;

/**
 * Compute MD5, SHA-1, SHA-256, SHA-512, BLAKE3, and xxHash64 over the input,
 * plus the PE import hash (imphash) when the input parses as a PE.
 *
 * Returns a JSON document; expected failures return
 * `{"schema_version":1,"error":"<code>"}` instead of throwing.
 */
export function hash_all(bytes: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly fuzzy_compare: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly fuzzy_hash: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly hash_all: (a: number, b: number, c: number) => void;
    readonly fuzzyhash: (a: number, b: number) => number;
    readonly fuzzyhash_compare: (a: number, b: number) => number;
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
