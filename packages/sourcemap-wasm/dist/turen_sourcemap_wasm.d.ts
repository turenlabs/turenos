/* tslint:disable */
/* eslint-disable */

/**
 * Resolve a sectioned index sourcemap (or normalize a regular one) into a
 * regular v3 sourcemap, returned as JSON text bytes capped at 32 MiB. Hermes
 * maps flatten to a regular map without `x_facebook_sources` scope metadata.
 * Errors are thrown as `JsError` whose message is the JSON error document.
 */
export function sourcemap_flatten(bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Summarize a `.map` document: kind (regular/index/hermes), version, file,
 * sourceRoot, debugId, bounded source list with per-source content
 * size + SHA-256 (contents are never inlined), name/mapping counts,
 * ignore-list entries, and index-map section metadata.
 *
 * Options: `{"maxSources": <usize, default 4096>, "maxSections": <usize,
 * default 4096>}`
 */
export function sourcemap_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Map a generated (minified) 0-indexed `{line, column}` to the closest
 * original token: `{source, sourceIndex, original:{line,column}, name,
 * isRange, mapped}`.
 *
 * Options: `{"line": <u32, required>, "column": <u32, required>}`
 */
export function sourcemap_lookup(bytes: Uint8Array, options_json: string): string;

/**
 * Map an original `{source|sourceIndex, line, column?}` to the generated
 * (minified) positions it produced. Index maps are flattened first.
 *
 * Options: `{"source": <string> | "sourceIndex": <u32>, "line": <u32,
 * required>, "column": <u32, optional>, "maxPositions": <usize, default
 * 4096>}`
 */
export function sourcemap_reverse_lookup(bytes: Uint8Array, options_json: string): string;

/**
 * Extract one embedded `sourcesContent` entry as UTF-8 bytes by `index` or
 * `path`. Index maps are flattened first; indexes then refer to the flattened
 * source list. Errors are thrown as `JsError` whose message is the JSON
 * error document.
 *
 * Options: `{"index": <u32> | "path": <string>}`
 */
export function sourcemap_source(bytes: Uint8Array, options_json: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly sourcemap_flatten: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sourcemap_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sourcemap_lookup: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sourcemap_reverse_lookup: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sourcemap_source: (a: number, b: number, c: number, d: number, e: number) => void;
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
