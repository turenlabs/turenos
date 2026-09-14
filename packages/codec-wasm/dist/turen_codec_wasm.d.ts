/* tslint:disable */
/* eslint-disable */

/**
 * Compress `bytes` with `algorithm`, returning one bounded byte vector.
 *
 * Algorithms: `gzip`, `zlib`, `deflate`, `brotli`, `lz4`, `lz4-block`, `xz`,
 * `lzma`, `lzma2`. `bzip2` and `zstd` are decode-only here and return
 * `unsupported`. Options: `level` (deflate 0-9 default 6, brotli 0-11
 * default 5; ignored elsewhere) and `maxOutputBytes`.
 */
export function compress(algorithm: string, bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Decode text `encoding` bytes back to raw bytes.
 *
 * Encodings match `encode`; `uudecode`/`uu` are accepted aliases for the
 * uuencode decoder, which locates a `begin`/`end` block inside the input.
 * Whitespace inside the payload is tolerated where the format allows it.
 */
export function decode(encoding: string, bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Decompress `bytes` with `algorithm`, returning one bounded byte vector.
 *
 * Algorithms: `gzip`, `zlib`, `deflate` (raw), `brotli`, `lz4` (frame),
 * `lz4-block` (size-prefixed), `bzip2`, `xz`, `lzma` (LZMA-Alone), `lzma2`,
 * `zstd`. Options: `maxOutputBytes` (default and ceiling 128 MiB),
 * `expectedOutputBytes` (allocation hint). Output exceeding the cap is a
 * hard `output_too_large` error; partial output is never returned.
 */
export function decompress(algorithm: string, bytes: Uint8Array, options_json: string): Uint8Array;

/**
 * Identify the likely compression format or text encoding of `bytes`.
 *
 * Always returns a JSON string: on success a report with `schema_version`,
 * `inputBytes`, `primary` (best guess or null) and `candidates`
 * (`{kind, name, confidence, detail}`); on failure the shared error envelope.
 */
export function detect(bytes: Uint8Array): string;

/**
 * Encode `bytes` to a text `encoding`, returned as UTF-8 bytes.
 *
 * Encodings: `hex`, `base64`, `base64url`, `base32`, `base32hex`, `base58`,
 * `base58check`, `z85` (input length must be a multiple of 4),
 * `quoted-printable` (RFC 2045), `uuencode`.
 */
export function encode(encoding: string, bytes: Uint8Array, options_json: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compress: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly decompress: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly detect: (a: number, b: number, c: number) => void;
    readonly encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
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
