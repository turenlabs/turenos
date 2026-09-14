/* tslint:disable */
/* eslint-disable */

/**
 * Security-focused finding list with byte offsets: objdata payloads, OLE
 * Package class names, data stores, file-table entries, template paths,
 * external field instructions, password markers, `\binN` binary blobs,
 * hex-heavy/fragmented obfuscation, nesting and brace anomalies, encoding
 * mixes, and Unicode anomalies.
 *
 * Options: `max_findings` (default and cap 4096), `min_severity`
 * ("info"|"low"|"medium"|"high" — report findings at or above the level).
 */
export function rtf_audit(bytes: Uint8Array, options_json: string): string;

/**
 * Full structural report: group statistics, control-word histogram, font
 * table, style sheet, color table, {\info} metadata, {\*\generator}, picture
 * and OLE-object summaries, file-table entries, field instructions, counts,
 * a body-text preview, and the input digest.
 *
 * Options: `top` (histogram rows, default 32, cap 256), `max_results`
 * (per-list cap, default 1024, hard cap 4096), `preview_chars` (text
 * preview, default 512, cap 4096).
 */
export function rtf_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Enumerate embedded OLE objects: `{\object}` groups with `\objdata`
 * hex-decoded payloads — objclass, declared dimensions, decoded size,
 * SHA-256, first-16-bytes preview, OLE compound-magic detection, decode
 * errors, and `{\result}` rendering-data presence. Full payload hex is
 * returned only when the decoded payload is ≤ 64 KiB and
 * `include_payload_hex` is set.
 *
 * Options: `max_results` (default 1024, cap 4096), `include_payload_hex`
 * (default false).
 */
export function rtf_objects(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded plain-text extraction: control words stripped, `\'hh` resolved
 * through the document code page, `\uN` resolved (with `\uc` fallback
 * skipping), and non-body destinations (font/color/style tables, info,
 * pictures, objects, `{\*\...}` ignorable groups, field instructions)
 * skipped.
 *
 * Options: `max_chars` (default 262144, cap 524288).
 */
export function rtf_text(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly rtf_audit: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rtf_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rtf_objects: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rtf_text: (a: number, b: number, c: number, d: number, e: number) => void;
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
