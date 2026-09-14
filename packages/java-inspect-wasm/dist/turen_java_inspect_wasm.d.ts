/* tslint:disable */
/* eslint-disable */

/**
 * javap-style bytecode listing for one class (all methods with Code) or one
 * method selected by `method_index`/`method_name`. Constant-pool references
 * resolve inline as `// ...` comments. Unknown opcodes and truncated
 * operands emit explicit `// WARNING` markers; listing text is capped at
 * 2 MiB with a `truncated` flag.
 *
 * Options: `method_index`, `method_name` (exact match, all overloads),
 * `max_methods` (cap 4096).
 */
export function class_disassemble(bytes: Uint8Array, options_json: string): string;

/**
 * Parse one `.class` file: version (major/minor -> JDK name), access flags,
 * this/super class, interfaces, constant-pool tag summary (full bounded dump
 * via `dump_constant_pool`), fields, methods with Code metrics, class
 * attributes (SourceFile, InnerClasses, Signature, annotations summary),
 * bootstrap methods (invokedynamic/lambda targets), and a findings array for
 * reflection, Unsafe, ClassLoader.defineClass, ProcessBuilder/Runtime.exec,
 * native methods, serialization, and script-engine references — each tagged
 * with its constant-pool index.
 *
 * Options: `dump_constant_pool` (default false), `max_entries` (cap 4096).
 */
export function class_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * JAR (ZIP) inspection: bounded entry table, META-INF/MANIFEST.MF decoded
 * (256 KiB cap, main attributes + digest attributes parsed), signing files
 * (.SF/.RSA/.DSA/.EC listed), .class entry count, multi-release flag, and
 * module-info.class presence. `entry_index` decompresses exactly one entry
 * (32 MiB cap) and embeds its `class_inspect` report — the
 * retrieve-one-entry path. Entries are read one at a time; nothing is
 * written to disk.
 *
 * Options: `max_entries` (cap 4096), `entry_index` (optional).
 */
export function jar_inspect(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly class_disassemble: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly class_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly jar_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
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
