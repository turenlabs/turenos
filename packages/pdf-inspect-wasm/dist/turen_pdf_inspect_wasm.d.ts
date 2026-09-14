/* tslint:disable */
/* eslint-disable */

/**
 * Document summary and suspicious-indicator findings.
 *
 * Options: `max_findings` (default `MAX_RESULTS`, cap `MAX_RESULTS`),
 * `max_urls` (default `MAX_URLS`, cap `MAX_URLS`).
 */
export function pdf_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded object table.
 *
 * Options: `object_id` + `generation` select one object, `type` filters by
 * `/Type` name, `kind` filters by object variant, `max_results` (default and
 * hard cap `MAX_RESULTS`).
 */
export function pdf_objects(bytes: Uint8Array, options_json: string): string;

/**
 * Decode one stream object selected by `object_id`/`generation` and return the
 * decoded bytes as base64 inside JSON. Options: `max_output_bytes` (default
 * `MAX_STREAM_DECODE_BYTES`, cap `MAX_STREAM_DECODE_BYTES`). Undecodable
 * filter chains report `unsupported_filter` with the offending names; decoded
 * output that would exceed the option fails closed with
 * `decoded_stream_too_large`; payloads too large for the JSON output cap are
 * delivered truncated with `truncated: true` and `delivered_bytes`.
 */
export function pdf_stream_decode(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded text extraction.
 *
 * Options: `start_page` (1-based, default 1), `max_pages` (default 1024, cap
 * 4096), `max_chars` (default 256 Ki, cap 512 Ki).
 */
export function pdf_text(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly pdf_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdf_objects: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdf_stream_decode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pdf_text: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
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
