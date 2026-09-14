/* tslint:disable */
/* eslint-disable */

/**
 * Inspect a minidump: header, stream directory, system info, exception,
 * threads, modules, memory regions, misc info, and Breakpad/Crashpad
 * annotations.
 */
export function minidump_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Bounded read of a virtual address range through the dump's memory regions.
 *
 * Options: `{"address": <u64 | "0x..">, "length": <u64 | "0x..">}`
 * where `0 < length <= 65536`.
 */
export function minidump_memory_read(bytes: Uint8Array, options_json: string): string;

/**
 * Module list with symbol identifiers (CodeView/PDB records, ELF build IDs,
 * debug identifiers) for matching against debug-symbols tool output.
 */
export function minidump_modules(bytes: Uint8Array, options_json: string): string;

/**
 * Decode one selected stream to JSON when the stream type has a typed
 * decoder, otherwise return a bounded base64 preview of the stream bytes.
 *
 * Options: `{"stream": <u32 | "0x.." | "Name">, "name": "<StreamName>",
 * "previewBytes": <usize>}`
 */
export function minidump_stream(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly minidump_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly minidump_memory_read: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly minidump_modules: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly minidump_stream: (a: number, b: number, c: number, d: number, e: number) => void;
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
