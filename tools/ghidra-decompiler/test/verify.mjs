import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const factory = createRequire(import.meta.url)(path.join(root, "dist/ghidra_decompiler.js"))
const module = await factory()
module._init_decompiler()

const sla = new Uint8Array(await readFile(path.join(root, "dist/Processors/x86/data/languages/x86-64.sla")))
const pspec = await readFile(path.join(root, "dist/Processors/x86/data/languages/x86-64.pspec"), "utf8")
const cspec = await readFile(path.join(root, "dist/Processors/x86/data/languages/x86-64-gcc.cspec"), "utf8")
const bytes = "554889e5897dfc8975f88b45fc0345f85dc3"
const image = `<binaryimage arch="x86:LE:64:default"><bytechunk space="ram" offset="0x1000">${bytes}${"00".repeat(32)}</bytechunk></binaryimage>`
const pointer = module._malloc(sla.length)
module.HEAPU8.set(sla, pointer)

try {
  const result = module.ccall(
    "decompile_pcode",
    "number",
    ["number", "number", "string", "string", "string", "string"],
    [pointer, sla.length, pspec, cspec, image, "0x1000"],
  )
  try {
    const code = module.UTF8ToString(result)
    if (!code.includes("return param_1 + param_2"))
      throw new Error(`Unexpected decompiler output:\n${code}`)
  } finally {
    module._free_string(result)
  }
} finally {
  module._free(pointer)
}

console.log("Ghidra WASM compatibility verified")
