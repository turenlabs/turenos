import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entry = path.join(root, "dist/monodis.js")
if (!existsSync(entry))
  throw new Error("dist/monodis.js is missing; run ./script/import-upstream.sh, then npm run build")

const factory = createRequire(import.meta.url)(entry)
const module = await factory()
module._init_monodis()

// Smoke: empty input must fail gracefully with an "Error: ..." string,
// never a throw or abort. A managed-PE differential fixture lands with
// the completed spike.
const pointer = module._malloc(0)
try {
  const result = module.ccall("monodis_disassemble", "number", ["number", "number", "string"], [pointer, 0, "{}"])
  try {
    const text = module.UTF8ToString(result)
    if (!text.startsWith("Error:"))
      throw new Error(`Expected graceful error for empty input, got:\n${text.slice(0, 500)}`)
  } finally {
    module._free_string(result)
  }
} finally {
  module._free(pointer)
}

console.log("monodis WASM smoke verified")
