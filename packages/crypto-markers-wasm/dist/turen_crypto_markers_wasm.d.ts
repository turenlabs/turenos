/* tslint:disable */
/* eslint-disable */

/**
 * Whole-buffer byte profile: length, entropy, histogram summary, null and
 * printable ratios, line-ending counts, longest run, and ASCII/UTF-16LE
 * string-count estimates.
 *
 * Options: `{minStringLength?: number (default 4, clamped 1..=64),
 * topBytes?: number (default 16, clamped 1..=64)}`.
 */
export function byte_stats(bytes: Uint8Array, options_json: string): string;

/**
 * Scan raw bytes for known cryptographic constants, algorithm identifier
 * OIDs, key-structure templates, and keying-material strings.
 *
 * Options: `{maxFindings?: number (default 4096, clamped 1..=4096),
 * minConfidence?: "low"|"medium"|"high" (default "low"),
 * algorithms?: string[] (filter by reported algorithm field)}`.
 */
export function crypto_constants(bytes: Uint8Array, options_json: string): string;

/**
 * Sliding-window Shannon entropy profile with byte-class summaries and
 * classification hints for triage (packed/encrypted vs code vs padding).
 *
 * Options: `{windowSize?: number (default 4096, clamped 16..=4194304),
 * stride?: number (default 4096, clamped 1..=4194304)}`.
 */
export function entropy_map(bytes: Uint8Array, options_json: string): string;

/**
 * Single-byte and short multi-byte XOR key detection. Scores candidate
 * decryptions by printable-ASCII ratio plus magic/content hits (MZ, ELF,
 * ZIP, PDF, PNG, PEM, http(s) URLs, ...). Scoring work is bounded to the
 * first 256 KiB of input unless `scanBytes` overrides.
 *
 * Options: `{topK?: number (default 8, clamped 1..=64), scanBytes?: number
 * (default min(262144, input), clamped 1..=4194304), maxKeyLength?: number
 * (default 1 = single-byte exhaustive only, clamped 1..=8; >1 enables
 * per-position multi-byte key recovery), minScore?: number (default 0),
 * keys?: string[] (extra hex-encoded candidate keys, up to 64 keys of at
 * most 32 bytes each)}`.
 */
export function xor_probe(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly byte_stats: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly crypto_constants: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly entropy_map: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly xor_probe: (a: number, b: number, c: number, d: number, e: number) => void;
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
