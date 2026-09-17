import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_wasm_toolkit_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_wasm_toolkit_wasm_bg.wasm")) })

// wat_compile produces the binary every other operation then consumes.
const text = `(module
  (type $t (func (param i32) (result i32)))
  (import "env" "log" (func $log (param i32)))
  (memory (export "mem") 1 4)
  (global $g (export "g") (mut i32) (i32.const 7))
  (func $f (export "f") (type $t) (param i32) (result i32)
    local.get 0)
)`
const wasm = api.wat_compile(new TextEncoder().encode(text), "{}")
assert.ok(wasm instanceof Uint8Array)
assert.deepEqual([...wasm.slice(0, 8)], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

// wasm_analyze on the compiled module.
const analysis = JSON.parse(api.wasm_analyze(wasm, "{}"))
assert.equal(analysis.schema_version, 1)
assert.equal(analysis.encoding, "module")
assert.equal(analysis.valid, true)
assert.equal(analysis.imports[0].module, "env")
assert.equal(analysis.imports[0].name, "log")
assert.equal(analysis.imports[0].kind, "func")
assert.ok(analysis.imports[0].signature.includes("param i32"))
const fExport = analysis.exports.find((entry) => entry.name === "f")
assert.equal(fExport.kind, "func")
assert.ok(fExport.signature.includes("result i32"))
assert.equal(analysis.functions.count, 1)
assert.ok(Array.isArray(analysis.features))
assert.ok(analysis.features.includes("mutable_global"))
assert.equal(analysis.memories[0].min_pages, 1)
assert.equal(analysis.memories[0].max_pages, 4)
assert.equal(analysis.feature_detection, "complete")

// Feature detection really detects: a SIMD + memory.copy module.
const simd = api.wat_compile(
  new TextEncoder().encode(`(module (memory 1)
    (func (param v128) (result v128) local.get 0 v128.not)
    (func i32.const 0 i32.const 0 i32.const 4 memory.copy))`),
  "{}",
)
const simdReport = JSON.parse(api.wasm_analyze(simd, "{}"))
assert.ok(simdReport.features.includes("simd"))
assert.ok(simdReport.features.includes("bulk_memory_opt"))

// wasm_print round-trips the compiled module back to text.
const printed = JSON.parse(api.wasm_print(wasm, "{}"))
assert.equal(printed.encoding, "module")
assert.equal(printed.truncated, false)
assert.ok(printed.wat.includes("(module"))
assert.ok(printed.wat.includes("local.get"))
const reprinted = api.wat_compile(new TextEncoder().encode(printed.wat), "{}")
assert.ok(reprinted instanceof Uint8Array)

const skeleton = JSON.parse(api.wasm_print(wasm, JSON.stringify({ skeleton: true })))
assert.ok(!skeleton.wat.includes("local.get"))
const truncated = JSON.parse(api.wasm_print(wasm, JSON.stringify({ maxWatBytes: 64 })))
assert.equal(truncated.truncated, true)
assert.ok(truncated.wat_bytes <= 64)

// wasm_metadata: producers absent on a bare module, name section present
// because wat wrote one for the named items.
const meta = JSON.parse(api.wasm_metadata(wasm, "{}"))
assert.equal(meta.encoding, "module")
assert.equal(meta.producers, null)
assert.equal(meta.source_mapping_url, null)
assert.equal(meta.name_section.section, "name")
assert.ok(meta.name_section.named_total >= 2)
assert.ok(meta.custom_sections.some((s) => s.name === "name" && s.recognized))

// Component detection end-to-end through wat_compile.
const component = api.wat_compile(new TextEncoder().encode("(component)"), "{}")
const componentMeta = JSON.parse(api.wasm_metadata(component, "{}"))
assert.equal(componentMeta.encoding, "component")

// Expected errors serialize as {schema_version:1,error}.
assert.equal(JSON.parse(api.wasm_analyze(new Uint8Array([1, 2, 3]), "{}")).error, "not_a_wasm_module")
assert.equal(JSON.parse(api.wasm_print(new Uint8Array([1, 2, 3]), "{}")).error, "not_a_wasm_module")
assert.equal(JSON.parse(api.wasm_metadata(new Uint8Array([1, 2, 3]), "{}")).error, "not_a_wasm_module")

const badWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0xff, 0xff])
const badReport = JSON.parse(api.wasm_analyze(badWasm, "{}"))
assert.equal(badReport.valid, false)
assert.ok(typeof badReport.validation_error === "string")

// Oversized input and oversized options are rejected before work.
const huge = new Uint8Array(33 * 1024 * 1024)
assert.equal(JSON.parse(api.wasm_analyze(huge, "{}")).error, "input_too_large")
assert.equal(JSON.parse(api.wasm_print(huge, "{}")).error, "input_too_large")
const bigOptions = `{"${"x".repeat(5000)}":1}`
assert.equal(JSON.parse(api.wasm_analyze(wasm, bigOptions)).error, "options_too_large")
assert.equal(JSON.parse(api.wasm_analyze(wasm, "not json")).error, "invalid_options")

// wat_compile failures throw a JS string carrying error JSON with a position.
let compileError = null
try {
  api.wat_compile(new TextEncoder().encode("(module (func"), "{}")
} catch (error) {
  compileError = JSON.parse(error)
}
assert.ok(compileError, "invalid wat must throw")
assert.equal(compileError.error, "wat_parse_error")
assert.ok(compileError.line >= 1 && compileError.column >= 1)

let binaryError = null
try {
  api.wat_compile(wasm, "{}")
} catch (error) {
  binaryError = JSON.parse(error)
}
assert.equal(binaryError.error, "expected_wat_text")

// Determinism: identical inputs produce byte-identical JSON.
assert.equal(api.wasm_analyze(wasm, "{}"), api.wasm_analyze(wasm, "{}"))
assert.equal(api.wasm_metadata(wasm, "{}"), api.wasm_metadata(wasm, "{}"))
assert.equal(api.wasm_print(wasm, "{}"), api.wasm_print(wasm, "{}"))

console.log("wasm-toolkit WASM compatibility verified")
