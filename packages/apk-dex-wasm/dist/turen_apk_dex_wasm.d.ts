/* tslint:disable */
/* eslint-disable */

/**
 * Inspect an APK (ZIP) container.
 *
 * Options: `{"decodeManifest": <bool, default true>, "dexDetails": <bool,
 * default false>, "maxEntries": <usize, default 4096>,
 * "maxEntryBytes": <u64, default 33554432>}`
 */
export function apk_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Decode Android binary XML (AXML) bytes to text XML.
 *
 * Options: `{"maxXmlBytes": <usize, clamped 1..1048576>}`
 */
export function axml_decode(bytes: Uint8Array, options_json: string): string;

/**
 * Inspect one raw `.dex` file (or pick `classesN.dex` out of an APK input).
 *
 * Options: `{"dexIndex": <u32, default 1>, "limit": <usize, default 4096>,
 * "includeStrings": <bool, default true>}`
 */
export function dex_inspect(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apk_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly axml_decode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dex_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
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
