import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2])
const api = await import(pathToFileURL(path.join(directory, "turen_wasm_inspect_wasm.js")).href)
await api.default({ module_or_path: await fs.readFile(path.join(directory, "turen_wasm_inspect_wasm_bg.wasm")) })

const minimal = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const report = JSON.parse(api.wasm_inspect(minimal, JSON.stringify({ maxSections: 16 })))
assert.equal(report.valid, true)
assert.equal(report.encoding, "module")
assert.equal(report.schema_version, 1)

const invalid = JSON.parse(api.wasm_inspect(new Uint8Array([1, 2, 3]), "{}"))
assert.equal(invalid.valid, false)
assert.deepEqual(invalid.warnings, ["not_a_wasm_module"])
console.log("wasm inspector verified")
