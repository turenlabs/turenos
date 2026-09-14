/* tslint:disable */
/* eslint-disable */

/**
 * Auto-detect the artifact kind and run the matching parser. The returned
 * JSON is identical to calling the named operation directly; unrecognized
 * input yields `{"schema_version":1,"error":"unknown_artifact"}`.
 *
 * Detection order: binary/XML plist, gzip-wrapped or raw FSEvents disk log
 * pages, `.DS_Store` buddy-allocator magic, then a tracev3 chunk preamble.
 * Options: same as the resolved operation.
 */
export function analyze(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one `.DS_Store` file: buddy-allocator header and TOC, the `DSDB`
 * superblock (root node, level count, record count, page size), then a
 * depth-limited (<=4) B-tree walk yielding `{filename, code, type, value}`
 * records capped at 4096. `blob` values render as `{length, sha256,
 * preview}`; `Iloc` blobs decode to `{x, y}`; `bwsp`/`lsvp`/`lsvP`/`icvp`
 * blobs decode inline as bounded plist JSON. Visited-node tracking makes
 * cyclic block graphs safe.
 *
 * Options: `max_results` (cap 4096, default 256).
 */
export function ds_store_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one `.fseventsd` disk-log file (gzip-wrapped or already
 * decompressed): `1SLD`/`2SLD`/`3SLD` record pages decoded to
 * `{event_id, path, flags {raw, names}, node_id}` rows, capped at 4096.
 * Decompression is capped at 64 MiB; a corrupt tail truncates with a warning
 * instead of failing the parse.
 *
 * Options: `max_results` (cap 4096, default 256).
 */
export function fsevents_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one Apple property list (binary `bplist00` or XML) into
 * bounded JSON: the full structure with depth capped at 32, per-container
 * items capped at 4096, strings capped at 1024 chars, `data` values rendered
 * as `{length, sha256, preview}`, `date`/`uid` wrapped with explicit type
 * markers, plus typed node counts and a maximum observed depth.
 *
 * Options: `max_depth` (cap 32), `max_items` (cap 4096),
 * `max_string_chars` (cap 1024).
 */
export function plist_parse(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one `.tracev3` unified-log file: header metadata (mach timebase,
 * boot UUID, build, hardware model, timezone), catalog statistics, and
 * reconstructed log entries `{timestamp, process, subsystem, category,
 * level, message}` capped at 4096. The module is byte-only: uuidtext/dsc
 * string tables and timesync records are unavailable, so unresolved format
 * strings surface as explicit `<Missing message data>` markers plus a
 * counted warning — never silently dropped.
 *
 * Options: `max_results` (cap 4096, default 256).
 */
export function unified_log_parse(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly analyze: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly ds_store_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly fsevents_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly plist_parse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly unified_log_parse: (a: number, b: number, c: number, d: number, e: number) => void;
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
