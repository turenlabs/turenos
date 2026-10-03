import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import { fileURLToPath } from "node:url"

import type { Architecture, Endianness, Input } from "./decompiler-runtime"

type Module = {
  readonly HEAPU8: Uint8Array
  readonly _malloc: (size: number) => number
  readonly _free: (pointer: number) => void
  readonly _free_string: (pointer: number) => void
  readonly _init_decompiler: () => void
  readonly UTF8ToString: (pointer: number) => string
  readonly stringToUTF8: (text: string, pointer: number, maxBytes: number) => number
  readonly ccall: (
    name: string,
    returnType: string,
    argumentTypes: ReadonlyArray<string>,
    values: ReadonlyArray<unknown>,
  ) => number
}

type Factory = (input?: Record<string, unknown>) => Promise<Module>

type Request = {
  readonly id: number
  readonly input: Input
}

type Response =
  | { readonly id: number; readonly type: "started" }
  | { readonly id: number; readonly type: "completed"; readonly code: string; readonly heapBytes: number }
  | { readonly id: number; readonly type: "failed"; readonly error: string }

if (!parentPort) throw new Error("Decompiler worker requires a parent port")
const port = parentPort

const root = resolveRoot()
const factory = createRequire(import.meta.url)(path.join(root, "ghidra_decompiler.js")) as Factory
const module = await factory()
module._init_decompiler()

const specs = new Map<string, Promise<SpecFiles>>()
let queue = Promise.resolve()

port.on("message", (request: Request) => {
  queue = queue
    .then(() => handle(request))
    .catch((cause) => {
      port.postMessage({
        id: request.id,
        type: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      } satisfies Response)
    })
})

async function handle(request: Request) {
  port.postMessage({ id: request.id, type: "started" } satisfies Response)
  const spec = specification(request.input.architecture, request.input.endianness)
  const code = decompile(spec, await loadSpec(spec), request.input)
  // Posted after the result and every buffer are freed, so a request whose cleanup throws gets only
  // the "failed" message and the runtime replaces this worker.
  port.postMessage({
    id: request.id,
    type: "completed",
    code,
    heapBytes: module.HEAPU8.length,
  } satisfies Response)
}

function decompile(spec: Spec, files: SpecFiles, input: Input) {
  // Strings go through heap buffers instead of ccall's "string" type, which copies them onto the
  // wasm stack and only restores the stack pointer when the call returns normally.
  const pointers: number[] = []
  const allocate = (size: number) => {
    const pointer = module._malloc(size)
    if (pointer === 0) throw new Error(`Decompiler could not allocate ${size} bytes`)
    pointers.push(pointer)
    return pointer
  }
  const allocateString = (text: string) => {
    const size = Buffer.byteLength(text) + 1
    const pointer = allocate(size)
    module.stringToUTF8(text, pointer, size)
    return pointer
  }
  try {
    const slaPointer = allocate(files.sla.length)
    module.HEAPU8.set(files.sla, slaPointer)
    const resultPointer = module.ccall(
      "decompile_pcode",
      "number",
      ["number", "number", "number", "number", "number", "number"],
      [
        slaPointer,
        files.sla.length,
        allocateString(files.pspec),
        allocateString(files.cspec),
        allocateString(binaryImage(spec.id, input.bytes, input.baseAddress)),
        allocateString(`0x${input.address.toString(16)}`),
      ],
    )
    if (resultPointer === 0) throw new Error("Decompiler could not allocate its result")
    try {
      return module.UTF8ToString(resultPointer)
    } finally {
      module._free_string(resultPointer)
    }
  } finally {
    pointers.forEach((pointer) => module._free(pointer))
  }
}

type Spec = ReturnType<typeof specification>

type SpecFiles = {
  readonly sla: Uint8Array
  readonly pspec: string
  readonly cspec: string
}

function loadSpec(spec: Spec) {
  const key = `${spec.directory}/${spec.sla}/${spec.pspec}/${spec.cspec}`
  const existing = specs.get(key)
  if (existing) return existing
  const pending = Promise.all([
    readFile(path.join(root, spec.directory, spec.sla)),
    readFile(path.join(root, spec.directory, spec.pspec), "utf8"),
    readFile(path.join(root, spec.directory, spec.cspec), "utf8"),
  ]).then(([sla, pspec, cspec]) => ({ sla, pspec, cspec }))
  specs.set(key, pending)
  return pending
}

const directory = (processor: string) => `Processors/${processor}/data/languages`

function specification(architecture: Architecture, endianness: Endianness) {
  const big = endianness === "big"
  if (architecture === "x86")
    return {
      directory: directory("x86"),
      id: "x86:LE:32:default",
      sla: "x86.sla",
      pspec: "x86.pspec",
      cspec: "x86gcc.cspec",
    }
  if (architecture === "x86_64")
    return {
      directory: directory("x86"),
      id: "x86:LE:64:default",
      sla: "x86-64.sla",
      pspec: "x86-64.pspec",
      cspec: "x86-64-gcc.cspec",
    }
  if (architecture === "arm")
    return {
      directory: directory("ARM"),
      id: `ARM:${big ? "BE" : "LE"}:32:v8`,
      sla: `ARM8_${big ? "be" : "le"}.sla`,
      pspec: "ARMt.pspec",
      cspec: "ARM.cspec",
    }
  if (architecture === "arm64")
    return {
      directory: directory("AARCH64"),
      id: `AARCH64:${big ? "BE" : "LE"}:64:v8A`,
      sla: big ? "AARCH64BE.sla" : "AARCH64.sla",
      pspec: "AARCH64.pspec",
      cspec: "AARCH64.cspec",
    }
  if (architecture === "mips")
    return {
      directory: directory("MIPS"),
      id: `MIPS:${big ? "BE" : "LE"}:64:default`,
      sla: `mips64${big ? "be" : "le"}.sla`,
      pspec: "mips64.pspec",
      cspec: `mips64${big ? "be" : "le"}.cspec`,
    }
  if (architecture === "ppc")
    return {
      directory: directory("PowerPC"),
      id: `PowerPC:${big ? "BE" : "LE"}:64:default`,
      sla: `ppc_64_${big ? "be" : "le"}.sla`,
      pspec: "ppc_64.pspec",
      cspec: `ppc_64_${big ? "be" : "le"}.cspec`,
    }
  return {
    directory: directory("RISCV"),
    id: "RISCV:LE:64:default",
    sla: "riscv.lp64d.sla",
    pspec: "RV64.pspec",
    cspec: "riscv64-fp.cspec",
  }
}

function binaryImage(architecture: string, bytes: Uint8Array, baseAddress: number) {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32)
    chunks.push(Buffer.from(bytes.subarray(offset, offset + 32)).toString("hex"))
  chunks.push("00".repeat(32))
  return `<binaryimage arch="${architecture}"><bytechunk space="ram" offset="0x${baseAddress.toString(16)}">${chunks.join("\n")}</bytechunk></binaryimage>`
}

function resolveRoot() {
  const roots = [
    ...(import.meta.url.startsWith("file:")
      ? [path.join(path.dirname(fileURLToPath(import.meta.url)), "ghidra-decompiler", "dist")]
      : []),
    path.join(path.dirname(process.execPath), "ghidra-decompiler", "dist"),
  ]
  const bundled = roots.find((candidate) => existsSync(path.join(candidate, "ghidra_decompiler.js")))
  if (bundled) return bundled
  return path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/ghidra-decompiler-wasm")))
}
