/* tslint:disable */
/* eslint-disable */

/**
 * Enumerate leaf paths (scalars and empty containers) with type tags.
 *
 * Options: `{limit?: number}` clamped to 0..=4096 (default 4096).
 * Returns `{"schema_version":1,"paths":[{"path":..,"type":..},..],
 * "count":n,"truncated":bool}`.
 */
export function json_paths(bytes: Uint8Array, options_json: string): string;

/**
 * Evaluate a jq filter over the input JSON values.
 *
 * Options: `{filter: string, slurp?: bool, nullInput?: bool,
 * limit?: number, rawOutput?: bool}`.
 *
 * Returns `{"schema_version":1,"results":[...],"truncated":bool}` or an error
 * document `{"schema_version":1,"error":"<code>",...}`. With `rawOutput`,
 * result entries are the jq `-r` text rendering (strings unwrapped, other
 * values as compact JSON) so every entry is a JSON string.
 */
export function json_query(bytes: Uint8Array, options_json: string): string;

/**
 * Summarize the top-level shape of a JSON document for agent orientation.
 *
 * Returns `{"schema_version":1,"type":..,"bytes":..,"length"?:..,"keys"?:[..],
 * "keyTypes"?:{..},"valueTypes"?:{..},"elementTypes"?:{..},"truncated":bool}`.
 */
export function json_stats(bytes: Uint8Array): string;

/**
 * Validate strict RFC 8259 JSON and report token statistics.
 *
 * Returns `{"schema_version":1,"valid":bool,"error"?:..,"message"?:..,
 * "line"?:..,"column"?:..,"stats":{bytes,depth,objectCount,arrayCount,
 * scalarCount}}`. Statistics come from an iterative pre-pass; they are exact
 * for valid input and best-effort otherwise.
 */
export function json_validate(bytes: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly json_paths: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly json_query: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly json_stats: (a: number, b: number, c: number) => void;
    readonly json_validate: (a: number, b: number, c: number) => void;
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
