/* tslint:disable */
/* eslint-disable */

/**
 * Deep static profile of a wasm module or component. Parse-only: the input
 * is validated and decoded but never instantiated or executed.
 *
 * Options: `maxItems` (u64) clamps every reported list (default 4,096).
 */
export function wasm_analyze(bytes: Uint8Array, options_json: string): string;

/**
 * Metadata extraction: producers section, name-section summary,
 * `sourceMappingURL`, recognized custom sections, and component outline.
 *
 * Options: `maxItems` (u64) clamps every reported list (default 4,096).
 */
export function wasm_metadata(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded `.wat` rendering of a wasm module or component.
 *
 * Options (JSON object, all optional):
 *
 * * `skeleton` (bool) - print section/item structure without function bodies.
 * * `foldExpressions` (bool) - folded s-expression instruction form.
 * * `printOffsets` (bool) - annotate printed lines with binary offsets.
 * * `maxWatBytes` (u64) - text cap, clamped to 8 MiB.
 *
 * Returns `{"schema_version":1,"encoding":..,"wat":"..","wat_bytes":N,
 * "truncated":bool,"input_bytes":N}` or an error JSON object.
 */
export function wasm_print(bytes: Uint8Array, options_json: string): string;

/**
 * Compiles WebAssembly text format to a validated wasm binary.
 *
 * Input is UTF-8 `.wat` text (module or component), output the binary bytes
 * (<= 32 MiB) as a `Uint8Array`. Failures throw a JS string containing the
 * error JSON; parse errors include `line`, `column`, and `offset`.
 */
export function wat_compile(bytes: Uint8Array, options_json: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly wasm_analyze: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_metadata: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_print: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wat_compile: (a: number, b: number, c: number, d: number, e: number) => void;
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
