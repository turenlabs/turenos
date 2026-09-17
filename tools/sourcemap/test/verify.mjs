import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Loads the real wasm-pack output (pkg/ or an artifact's dist/) and exercises
// every exported operation end to end. No mocks: source maps are fabricated
// here with the same base64-VLQ encoding the format uses.

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_sourcemap_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_sourcemap_wasm_bg.wasm")) })

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const bytes = (text) => encoder.encode(text)
const json = (text) => JSON.parse(text)

// --- base64 VLQ encoder -----------------------------------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function vlqValue(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ""
  do {
    let digit = rest & 31
    rest >>= 5
    if (rest > 0) digit |= 32
    out += B64[digit]
  } while (rest > 0)
  return out
}
const segment = (...fields) => fields.map(vlqValue).join("")

// Canonical fixture: generated (minified) side is 0-indexed.
//   (0,0)  -> alpha.js (0,0)  name "alphaFn"
//   (0,10) -> alpha.js (0,10)
//   (0,20) -> beta.js  (5,2)  name "betaFn"
//   (2,0)  -> alpha.js (1,0)
//   (2,5)  -> unmapped
const mappings = `${segment(0, 0, 0, 0, 0)},${segment(10, 0, 0, 10)},${segment(10, 1, 5, -8, 1)};;${segment(0, -1, -4, -2)},${segment(5)}`
assert.equal(mappings, "AAAAA,UAAU,UCKRC;;ADJF,K")
const map = bytes(JSON.stringify({
  version: 3,
  file: "bundle.min.js",
  sourceRoot: "webpack://demo",
  sources: ["./src/alpha.js", "./src/beta.js"],
  sourcesContent: ["const alpha = 1;\n", "const beta = 2;\n"],
  names: ["alphaFn", "betaFn"],
  mappings,
  ignoreList: [1],
  debugId: "3fa48559-0000-4000-a000-000000000000",
}))

const indexMap = bytes(JSON.stringify({
  version: 3,
  file: "bundle.min.js",
  sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.js"], names: ["aFn"], mappings: segment(0, 0, 0, 0, 0) } },
    { offset: { line: 5, column: 10 }, map: { version: 3, sources: ["b.js"], sourcesContent: ["B!"], mappings: segment(0, 0, 0, 0) } },
  ],
}))
const indexMapExternal = bytes(JSON.stringify({
  version: 3,
  sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.js"], mappings: segment(0, 0, 0, 0) } },
    { offset: { line: 9, column: 0 }, url: "https://cdn.example.com/part2.js.map" },
  ],
}))

// --- sourcemap_inspect ------------------------------------------------------
const report = json(api.sourcemap_inspect(map, "{}"))
assert.equal(report.schema_version, 1)
assert.equal(report.kind, "regular")
assert.equal(report.version, 3)
assert.equal(report.file, "bundle.min.js")
assert.equal(report.source_root, "webpack://demo")
assert.equal(report.debug_id, "3fa48559-0000-4000-a000-000000000000")
assert.equal(report.sources_count, 2)
assert.equal(report.names_count, 2)
assert.equal(report.mappings_count, 5)
assert.deepEqual(report.ignore_list, [1])
assert.equal(report.ignore_list_present, true)
assert.equal(report.truncated, false)
assert.equal(report.sources.length, 2)
assert.equal(report.sources[0].source, "webpack://demo/./src/alpha.js")
assert.equal(report.sources[0].has_content, true)
assert.equal(report.sources[0].content_bytes, 17)
assert.equal(
  report.sources[0].content_sha256,
  createHash("sha256").update("const alpha = 1;\n").digest("hex"),
)
assert.equal(report.sources[0].ignored, false)
assert.equal(report.sources[1].ignored, true)
assert.equal(report.sources[0].content, undefined) // contents never inlined

const indexReport = json(api.sourcemap_inspect(indexMap, "{}"))
assert.equal(indexReport.kind, "index")
assert.equal(indexReport.sections_count, 2)
assert.equal(indexReport.unresolved_sections, 0)
assert.deepEqual(indexReport.sections[1].offset, { line: 5, column: 10 })
assert.equal(indexReport.sections[1].embedded, true)
assert.equal(indexReport.sections[1].embedded_kind, "regular")

const externalReport = json(api.sourcemap_inspect(indexMapExternal, "{}"))
assert.equal(externalReport.unresolved_sections, 1)
assert.equal(externalReport.sections[1].embedded, false)
assert.ok(externalReport.warnings.length > 0)

// --- sourcemap_lookup -------------------------------------------------------
const hit = json(api.sourcemap_lookup(map, JSON.stringify({ line: 0, column: 0 })))
assert.equal(hit.found, true)
assert.deepEqual(hit.token.generated, { line: 0, column: 0 })
assert.equal(hit.token.mapped, true)
assert.equal(hit.token.source, "webpack://demo/./src/alpha.js")
assert.equal(hit.token.source_index, 0)
assert.deepEqual(hit.token.original, { line: 0, column: 0 })
assert.equal(hit.token.name, "alphaFn")
assert.equal(hit.token.is_range, false)

// Between mappings: greatest lower bound wins.
const between = json(api.sourcemap_lookup(map, JSON.stringify({ line: 0, column: 5 })))
assert.deepEqual(between.token.generated, { line: 0, column: 0 })
// Past the last segment clamps to the final token of the line.
const tail = json(api.sourcemap_lookup(map, JSON.stringify({ line: 0, column: 999 })))
assert.equal(tail.token.name, "betaFn")
// Unmapped generated token is reported without a source.
const unmapped = json(api.sourcemap_lookup(map, JSON.stringify({ line: 2, column: 5 })))
assert.equal(unmapped.found, true)
assert.equal(unmapped.token.mapped, false)
assert.equal(unmapped.token.source, null)
// Empty map is a clean miss, not an error.
const miss = json(api.sourcemap_lookup(bytes('{"version":3,"sources":[],"mappings":""}'), JSON.stringify({ line: 0, column: 0 })))
assert.equal(miss.found, false)
assert.equal(miss.error, undefined)
// Index-map lookups return global generated coordinates.
const sectioned = json(api.sourcemap_lookup(indexMap, JSON.stringify({ line: 5, column: 10 })))
assert.equal(sectioned.found, true)
assert.equal(sectioned.token.source, "b.js")
assert.deepEqual(sectioned.token.generated, { line: 5, column: 10 })
// External-only sections miss instead of resolving.
const externalLookup = json(api.sourcemap_lookup(indexMapExternal, JSON.stringify({ line: 9, column: 0 })))
assert.equal(externalLookup.found, false)
// Missing required options are bounded errors.
assert.equal(json(api.sourcemap_lookup(map, "{}")).error, "missing_option")

// --- sourcemap_reverse_lookup -----------------------------------------------
const reverse = json(api.sourcemap_reverse_lookup(map, JSON.stringify({ source: "webpack://demo/./src/alpha.js", line: 0 })))
assert.equal(reverse.found, true)
assert.equal(reverse.position_count, 2)
assert.deepEqual(reverse.positions[0], { line: 0, column: 0, name: "alphaFn", is_range: false })
assert.deepEqual(reverse.positions[1], { line: 0, column: 10, name: null, is_range: false })
// Suffix resolution and column filtering.
const suffix = json(api.sourcemap_reverse_lookup(map, JSON.stringify({ source: "src/alpha.js", line: 0, column: 10 })))
assert.equal(suffix.position_count, 1)
assert.equal(suffix.positions[0].column, 10)
// sourceIndex works and unknown sources miss cleanly.
const byIndex = json(api.sourcemap_reverse_lookup(map, JSON.stringify({ sourceIndex: 1, line: 5, column: 2 })))
assert.deepEqual(byIndex.positions[0], { line: 0, column: 20, name: "betaFn", is_range: false })
const noMatch = json(api.sourcemap_reverse_lookup(map, JSON.stringify({ source: "gamma.js", line: 0 })))
assert.equal(noMatch.found, false)
assert.equal(noMatch.position_count, 0)
assert.equal(json(api.sourcemap_reverse_lookup(map, JSON.stringify({ line: 0 }))).error, "missing_option")

// --- sourcemap_source -------------------------------------------------------
const source0 = decoder.decode(api.sourcemap_source(map, JSON.stringify({ index: 0 })))
assert.equal(source0, "const alpha = 1;\n")
const sourceByPath = decoder.decode(api.sourcemap_source(map, JSON.stringify({ path: "beta.js" })))
assert.equal(sourceByPath, "const beta = 2;\n")
// Error surfaces throw with the error document as the message.
const errorCode = (fn) => {
  try {
    fn()
  } catch (error) {
    return json(error.message).error
  }
  throw new Error("expected the operation to throw")
}
assert.equal(errorCode(() => api.sourcemap_source(map, JSON.stringify({ index: 7 }))), "source_not_found")
assert.equal(errorCode(() => api.sourcemap_source(indexMapExternal, JSON.stringify({ index: 0 }))), "unresolved_sections")
const noContent = bytes('{"version":3,"sources":["x.js"],"mappings":"AAAA"}')
assert.equal(errorCode(() => api.sourcemap_source(noContent, JSON.stringify({ index: 0 }))), "no_source_content")

// --- sourcemap_flatten ------------------------------------------------------
const flattened = json(decoder.decode(api.sourcemap_flatten(indexMap, "{}")))
assert.equal(flattened.version, 3)
assert.equal(flattened.file, "bundle.min.js")
assert.deepEqual(flattened.sources, ["a.js", "b.js"])
assert.equal(flattened.sourcesContent[1], "B!")
assert.equal(typeof flattened.mappings, "string")
// Flattening a regular map is an identity normalization.
const flattenedRegular = json(decoder.decode(api.sourcemap_flatten(map, "{}")))
assert.equal(flattenedRegular.version, 3)
assert.equal(flattenedRegular.sources.length, 2)
// Unresolved external sections fail closed.
assert.equal(errorCode(() => api.sourcemap_flatten(indexMapExternal, "{}")), "unresolved_sections")

// --- malformed inputs and hard limits ---------------------------------------
assert.equal(json(api.sourcemap_inspect(bytes("not json"), "{}")).error, "invalid_json")
assert.equal(json(api.sourcemap_inspect(bytes('{"version":3,"mappings":"AAAA'), "{}")).error, "invalid_json")
// An empty object is a valid (empty) map, not an error.
assert.equal(json(api.sourcemap_inspect(bytes("{}"), "{}")).kind, "regular")
assert.equal(json(api.sourcemap_lookup(bytes("[]"), '{"line":0,"column":0}')).error, "invalid_json")
assert.equal(json(api.sourcemap_inspect(bytes('{"version":3,"sources":["a"],"mappings":"AAAAg"}'), "{}")).error, "invalid_mappings")
assert.equal(json(api.sourcemap_inspect(bytes('{"version":3,"sources":[],"mappings":"AACA"}'), "{}")).error, "bad_source_reference")
// Options validation.
assert.equal(json(api.sourcemap_inspect(map, "[1]")).error, "options_invalid")
assert.equal(json(api.sourcemap_inspect(map, "not json")).error, "options_invalid")
// Hard limits: 32 MiB input, 4 KiB options.
const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
assert.equal(json(api.sourcemap_inspect(oversized, "{}")).error, "input_too_large")
assert.equal(json(api.sourcemap_lookup(oversized, "{}")).error, "input_too_large")
assert.equal(errorCode(() => api.sourcemap_source(oversized, "{}")), "input_too_large")
assert.equal(errorCode(() => api.sourcemap_flatten(oversized, "{}")), "input_too_large")
const bigOptions = `{"line":0,"column":0,"pad":"${"x".repeat(4096)}"}`
assert.equal(json(api.sourcemap_lookup(map, bigOptions)).error, "options_too_large")
assert.equal(errorCode(() => api.sourcemap_source(map, bigOptions)), "options_too_large")

// --- determinism ------------------------------------------------------------
assert.equal(api.sourcemap_inspect(map, "{}"), api.sourcemap_inspect(map, "{}"))
assert.equal(api.sourcemap_lookup(map, '{"line":0,"column":5}'), api.sourcemap_lookup(map, '{"line":0,"column":5}'))
assert.deepEqual(api.sourcemap_source(map, '{"index":0}'), api.sourcemap_source(map, '{"index":0}'))

console.log("sourcemap WASM compatibility verified")
