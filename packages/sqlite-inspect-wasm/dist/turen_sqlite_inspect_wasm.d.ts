/* tslint:disable */
/* eslint-disable */

/**
 * `sqlite_carve`: heuristic scan of unallocated gaps, freeblock bodies, and
 * freelist pages for record-shaped data. Candidates are labelled heuristic —
 * they are not verified live rows.
 */
export function sqlite_carve(bytes: Uint8Array, options_json: string): string;

/**
 * `sqlite_freelist`: walk the freelist trunk-page chain — each trunk's next
 * pointer and leaf-page list, declared vs counted free pages, broken links,
 * cycles, and carvable-byte statistics.
 */
export function sqlite_freelist(bytes: Uint8Array, options_json: string): string;

/**
 * `sqlite_inspect` (default op): decode the 100-byte database header —
 * magic, page size, journal mode (WAL vs rollback), change counter,
 * in-header db size, freelist summary, schema cookie/format, autovacuum,
 * text encoding, user version, application id, and validity flags.
 */
export function sqlite_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * `sqlite_rows`: decode rows of the named table's root b-tree in rowid
 * order. Options: `{"table":"name","maxRows":<=256,"blobPreviewBytes":<=256}`.
 * Blobs are reported as `{type:"blob",length,sha256,previewHex}` — never
 * inlined beyond the preview cap.
 */
export function sqlite_rows(bytes: Uint8Array, options_json: string): string;

/**
 * `sqlite_schema`: walk the sqlite_master b-tree rooted at page 1 and emit
 * every schema record `{type, name, tblName, rootpage, sql}` (bounded).
 */
export function sqlite_schema(bytes: Uint8Array, options_json: string): string;

/**
 * `sqlite_table_stats`: per-table b-tree walk — page counts by type,
 * overflow pages, row count, depth, min/max rowid, corrupt findings.
 * Option `{"table":"name"}` limits the walk to one table.
 */
export function sqlite_table_stats(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly sqlite_carve: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sqlite_freelist: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sqlite_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sqlite_rows: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sqlite_schema: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sqlite_table_stats: (a: number, b: number, c: number, d: number, e: number) => void;
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
