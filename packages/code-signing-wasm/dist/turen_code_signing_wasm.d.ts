/* tslint:disable */
/* eslint-disable */

/**
 * Inspect one X.509 certificate (DER) or a PEM bundle of certificates.
 * Returns `{schema_version, certificates, count, ...}`. Parse only; no trust
 * or signature verification is performed.
 */
export function cert_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Inspect an X.509 certificate revocation list (DER or PEM).
 */
export function crl_inspect(bytes: Uint8Array, options_json: string): string;

/**
 * Locate LC_CODE_SIGNATURE in a Mach-O image and parse the code-signing
 * SuperBlob: CodeDirectory, requirements, entitlements, and CMS signature.
 * Parse only; no signature or requirement evaluation.
 */
export function macho_codesign(bytes: Uint8Array, options_json: string): string;

/**
 * Extract the PE attribute-certificate table (WIN_CERTIFICATE) and parse the
 * enclosed PKCS#7/Authenticode structure. Reports SpcIndirectData facts and
 * page-hash attribute presence. Parse only.
 */
export function pe_authenticode(bytes: Uint8Array, options_json: string): string;

/**
 * Inspect a PKCS#7/CMS ContentInfo structure (DER or PEM). Reports the
 * SignedData signer infos, embedded certificates, countersignatures, and the
 * messageDigest-vs-content structural comparison. Never verifies signatures.
 */
export function pkcs7_inspect(bytes: Uint8Array, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly cert_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly crl_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly macho_codesign: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pe_authenticode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pkcs7_inspect: (a: number, b: number, c: number, d: number, e: number) => void;
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
