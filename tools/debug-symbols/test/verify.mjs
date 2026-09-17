import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(process.argv[2] ?? "pkg")
const fixture = path.resolve(process.argv[3] ?? "test/fixture")
const api = await import(pathToFileURL(path.join(root, "turen_debug_symbols_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(root, "turen_debug_symbols_wasm_bg.wasm")) })

const report = JSON.parse(api.inspect(await readFile(fixture), JSON.stringify({ demangle: true })))
assert.ok(report.symbols.length > 0)
assert.ok(Array.isArray(report.debug_sections))
assert.ok(report.debug_sections.length === 0 || report.debug_sections.some((section) => section.name.includes("debug_info")))
assert.equal(report.error, undefined)

const invalid = JSON.parse(api.inspect(new Uint8Array([1, 2, 3]), "{}"))
assert.equal(invalid.error, "unsupported_debug_container")
console.log("debug symbols WASM verified")
