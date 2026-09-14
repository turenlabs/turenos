/* tslint:disable */
/* eslint-disable */

/**
 * Report the static `FeatureSet` extracted from `input`: formats/os/arch,
 * sections, libraries, import/export entries, api/import match-set samples,
 * string-table statistics with a bounded distinct-value sample, embedded-PE
 * offsets, and the input SHA-256.
 *
 * Options: `maxStrings` (default 256, ceiling 4096) bounds the
 * api/import/string sample lists.
 */
export function capa_features(input: Uint8Array, options_json: string): string;

/**
 * Match the embedded capa-rules ruleset against `input`.
 *
 * Options: `maxResults` (default and ceiling 4096), `includeEvidence`
 * (default true), `includeSkipped` (default false — also emit the
 * per-rule skipped list), `includeLib` (default false — `lib: true` rules
 * still evaluate so `match:` references work, but stay out of the report).
 */
export function capa_match(input: Uint8Array, options_json: string): string;

/**
 * Report embedded ruleset metadata: provenance commit, imported flag, rule /
 * namespace / library counts, per-reason skip counts, unsupported feature
 * kinds, embedded byte-pattern count, and parse errors.
 *
 * Options: `verbose` (default false) additionally emits the full rule list.
 */
export function capa_ruleset(options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly capa_features: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly capa_match: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly capa_ruleset: (a: number, b: number, c: number) => void;
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
