/* tslint:disable */
/* eslint-disable */

/**
 * EXIF/TIFF tag extraction from the container's EXIF block (JPEG APP1, PNG
 * eXIf, WebP EXIF, AVIF Exif item, or a TIFF file itself). GPS coordinates,
 * camera fields, and thumbnail presence (bytes only when <= 256 KiB, else
 * size + SHA-256 + offset). `exif_present: false` when the container has no
 * EXIF block; `invalid_exif` when a found block fails to parse.
 *
 * Options: `max_fields` (default 512, cap 4096).
 */
export function image_exif(bytes: Uint8Array, options_json: string): string;

/**
 * Format detection plus per-format structure: chunk/segment/block tables,
 * dimensions, bit depth, color type, decoded text chunks, EXIF/XMP/ICC
 * presence, trailing bytes past the end-of-image marker, and anomaly flags.
 *
 * Options: `max_entries` (default and cap 4096), `max_text_bytes` (default
 * and cap 2048), `include_text` (default true).
 */
export function image_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded pixel statistics: 16-bin luma histogram plus per-channel means.
 * PNG and JPEG only; dimensions are checked from the header before decode
 * and anything over `max_dimension` (default and cap 4096) is refused.
 */
export function image_pixel_stats(bytes: Uint8Array, options_json: string): string;

/**
 * All textual metadata across formats — PNG tEXt/zTXt/iTXt, JPEG COM and
 * XMP, GIF comments and plain text, WebP XMP, TIFF ASCII tags — as
 * `{location, keyword, text<=2KiB}`. Non-UTF-8 payloads surface as hex so
 * prompt-injection and stego carriers stay inspectable.
 *
 * Options: `max_entries` (default and cap 4096), `max_text_bytes` (default
 * and cap 2048).
 */
export function image_text_chunks(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly image_exif: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly image_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly image_pixel_stats: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly image_text_chunks: (a: number, b: number, c: number, d: number, e: number) => void;
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
