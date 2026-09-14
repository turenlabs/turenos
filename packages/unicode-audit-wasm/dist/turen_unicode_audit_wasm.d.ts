/* tslint:disable */
/* eslint-disable */

/**
 * Detect the likely encoding of `bytes`.
 *
 * Options: `{"tld": "<lower-case-dns-label>", "iso2022jp": <bool>}`
 */
export function text_detect(bytes: Uint8Array, options_json: string): string;

/**
 * Line, codepoint, script-histogram, and cleanliness statistics for `bytes`.
 *
 * Options: `{"encoding": "<label>|auto", "tld": "<lower-case-dns-label>"}`
 */
export function text_stats(bytes: Uint8Array, options_json: string): string;

/**
 * Decode `bytes` from a known or detected encoding and return bounded UTF-8
 * text (optionally normalized).
 *
 * Options: `{"from": "<label>|auto", "to": "utf-8", "normalize": "nfc|nfd|nfkc|nfkd"}`
 */
export function text_transcode(bytes: Uint8Array, options_json: string): string;

/**
 * Audit `bytes` for Unicode security issues: Trojan-Source bidi controls,
 * invisible/zero-width characters, unusual whitespace, mixed-script
 * identifiers, stray control characters, and bidirectional spans whose
 * display order diverges from storage order.
 *
 * The input is decoded as UTF-8 with lossy replacement before scanning; byte
 * offsets, lines, and columns refer to that decoded view.
 *
 * Options: `{"maxFindings": <usize>, "contextBytes": <usize>}` — both
 * camelCase and snake_case keys are accepted.
 */
export function unicode_audit(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly text_detect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly text_stats: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly text_transcode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly unicode_audit: (a: number, b: number, c: number, d: number, e: number) => void;
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
