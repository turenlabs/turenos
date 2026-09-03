/* tslint:disable */
/* eslint-disable */

export class Compiler {
  free(): void
  [Symbol.dispose](): void
  addSource(source: string): void
  build(): Rules
  defineGlobal(identifier: string, value: any): void
  constructor()
  newNamespace(namespace: string): void
  readonly errors: string[]
  readonly warnings: string[]
}

export class Rules {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  scan(payload: Uint8Array): any
  scanner(): Scanner
  readonly warnings: string[]
}

export class Scanner {
  free(): void
  [Symbol.dispose](): void
  constructor(rules: Rules)
  scan(payload: Uint8Array): any
  setGlobal(identifier: string, value: any): void
  setMaxMatchesPerPattern(n: number): void
  setTimeoutMs(timeout_ms: number): void
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

export interface InitOutput {
  readonly memory: WebAssembly.Memory
  readonly __wbg_compiler_free: (a: number, b: number) => void
  readonly __wbg_rules_free: (a: number, b: number) => void
  readonly __wbg_scanner_free: (a: number, b: number) => void
  readonly compiler_addSource: (a: number, b: number, c: number) => [number, number]
  readonly compiler_build: (a: number) => [number, number, number]
  readonly compiler_defineGlobal: (a: number, b: number, c: number, d: any) => [number, number]
  readonly compiler_errors: (a: number) => [number, number, number, number]
  readonly compiler_new: () => number
  readonly compiler_newNamespace: (a: number, b: number, c: number) => [number, number]
  readonly compiler_warnings: (a: number) => [number, number, number, number]
  readonly rules_scan: (a: number, b: number, c: number) => [number, number, number]
  readonly rules_scanner: (a: number) => number
  readonly rules_warnings: (a: number) => [number, number]
  readonly scanner_new: (a: number) => number
  readonly scanner_scan: (a: number, b: number, c: number) => [number, number, number]
  readonly scanner_setGlobal: (a: number, b: number, c: number, d: any) => [number, number]
  readonly scanner_setMaxMatchesPerPattern: (a: number, b: number) => void
  readonly scanner_setTimeoutMs: (a: number, b: number) => void
  readonly wasm_bindgen__convert__closures_____invoke__h2e602d28c3701e16: (
    a: number,
    b: number,
    c: any,
    d: any,
    e: any,
    f: any,
  ) => any
  readonly __wbindgen_malloc_command_export: (a: number, b: number) => number
  readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number
  readonly __wbindgen_exn_store_command_export: (a: number) => void
  readonly __externref_table_alloc_command_export: () => number
  readonly __wbindgen_externrefs: WebAssembly.Table
  readonly __wbindgen_destroy_closure_command_export: (a: number, b: number) => void
  readonly __externref_table_dealloc_command_export: (a: number) => void
  readonly __externref_drop_slice_command_export: (a: number, b: number) => void
  readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void
  readonly __wbindgen_start: () => void
}

export type SyncInitInput = BufferSource | WebAssembly.Module

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>,
): Promise<InitOutput>
