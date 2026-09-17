import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_json_query_wasm.js")).href)
await api.default({
  module_or_path: await readFile(path.join(directory, "turen_json_query_wasm_bg.wasm")),
})

const enc = new TextEncoder()
const query = (input, options) =>
  JSON.parse(api.json_query(typeof input === "string" ? enc.encode(input) : input, options))
const opts = (filter, extra = {}) => JSON.stringify({ filter, ...extra })

// identity, field access, iteration
{
  const result = query('{"a":[1,2,3],"b":"x"}', opts("."))
  assert.deepEqual(result.results[0], { a: [1, 2, 3], b: "x" })
  assert.equal(result.truncated, false)
}
{
  const result = query('{"items":[{"n":1},{"n":2}]}', opts(".items[].n"))
  assert.deepEqual(result.results, [1, 2])
}
// select, map, reduce, group_by, length, keys
{
  assert.deepEqual(query("[1,2,3,4]", opts("map(select(. > 2))")).results, [[3, 4]])
  assert.deepEqual(query("[1,2,3]", opts("reduce .[] as $x (0; . + $x)")).results, [6])
  assert.deepEqual(
    query(
      '[{"k":"a","v":1},{"k":"b","v":2},{"k":"a","v":3}]',
      opts("group_by(.k) | map({key: .[0].k, total: (map(.v) | add)})"),
    ).results,
    [[{ key: "a", total: 4 }, { key: "b", total: 2 }]],
  )
  assert.deepEqual(query('{"a":1,"b":[2]}', opts("length")).results, [2])
  assert.deepEqual(query('{"b":1,"a":[2]}', opts("keys")).results, [["a", "b"]])
}
// recursive descent
{
  const result = query('{"a":{"b":{"c":42}},"d":[1,{"c":7}]}', opts("[.. | numbers]"))
  assert.deepEqual(result.results, [[42, 1, 7]])
}
// stdlib regex/format/time funs are wired up
{
  assert.deepEqual(query('"abc123"', opts('test("[0-9]+")')).results, [true])
  assert.deepEqual(query('"hi"', opts("@base64")).results, ["aGk="])
  assert.deepEqual(query('"2020-01-01T00:00:00Z"', opts("fromdateiso8601")).results, [1577836800])
}
// filter parse and compile errors carry positions
{
  const result = query("{}", opts(".["))
  assert.equal(result.error, "filter_parse_error")
  assert.equal(typeof result.errors[0].offset, "number")
  const missing = query("{}", opts("nosuchfilter"))
  assert.equal(missing.error, "filter_compile_error")
  assert.match(missing.errors[0].message, /nosuchfilter/)
}
// blocked host-side filters are compile errors
for (const blocked of ["env", "now"]) {
  const result = query("{}", opts(blocked))
  assert.equal(result.error, "filter_compile_error")
}
// runtime errors and halt are JSON errors, not traps or exits
{
  assert.equal(query("1", opts(".a")).error, "eval_error")
  const boom = query("{}", opts('error("boom")'))
  assert.equal(boom.error, "eval_error")
  assert.match(boom.message, /boom/)
  assert.equal(query("{}", opts("halt")).error, "halted")
}
// slurp vs default multi-document handling
{
  const input = '{"a":1}\n{"a":2}'
  assert.deepEqual(query(input, opts("length", { slurp: true })).results, [2])
  assert.deepEqual(query(input, opts(".a")).results, [1, 2])
}
// nullInput ignores (even malformed) input bytes
{
  const result = query("not json at all", opts("1 + 1", { nullInput: true }))
  assert.deepEqual(result.results, [2])
}
// inputs consumes the remaining document stream
{
  assert.deepEqual(query("1 2 3", opts("[., inputs]")).results, [[1, 2, 3]])
}
// limit truncation
{
  const result = query("[1,2,3,4,5]", opts(".[]", { limit: 3 }))
  assert.deepEqual(result.results, [1, 2, 3])
  assert.equal(result.truncated, true)
}
// raw output renders strings unwrapped
{
  const result = query('["a",1,null]', opts(".[]", { rawOutput: true }))
  assert.deepEqual(result.results, ["a", "1", "null"])
  assert.equal(result.raw, true)
}
// malformed JSON, empty input, oversized input/options
{
  assert.equal(query("{bad", opts(".")).error, "input_parse_error")
  assert.deepEqual(query("", opts(".")).results, [])
  assert.equal(
    query(new Uint8Array(32 * 1024 * 1024 + 1), opts(".")).error,
    "input_too_large",
  )
  assert.equal(
    query("1", JSON.stringify({ filter: ".".repeat(64 * 1024) })).error,
    "options_too_large",
  )
  assert.equal(query("1", "{}").error, "missing_filter")
  assert.equal(query("1", "{bad json").error, "options_invalid")
}
// deeply nested input is rejected before recursive parsing
{
  const deep = "[".repeat(600)
  assert.equal(query(deep, opts(".")).error, "input_too_deep")
  const report = JSON.parse(api.json_validate(enc.encode(deep)))
  assert.equal(report.valid, false)
  assert.equal(report.error, "depth_exceeded")
}
// json_validate: valid doc + stats, invalid doc + position, strictness
{
  const report = JSON.parse(api.json_validate(enc.encode('{"a":[1,"x",null],"b":{"c":true}}')))
  assert.equal(report.valid, true)
  assert.equal(report.stats.objectCount, 2)
  assert.equal(report.stats.arrayCount, 1)
  assert.equal(report.stats.scalarCount, 4)
  assert.equal(report.stats.depth, 2)
  const invalid = JSON.parse(api.json_validate(enc.encode("{bad")))
  assert.equal(invalid.valid, false)
  assert.equal(invalid.error, "invalid_json")
  assert.equal(typeof invalid.line, "number")
  for (const bad of ["NaN", "1 2", "[1,]"]) {
    const parsed = JSON.parse(api.json_validate(enc.encode(bad)))
    assert.equal(parsed.valid, false, `input ${bad}`)
  }
}
// json_stats: object and array shape summaries
{
  const stats = JSON.parse(api.json_stats(enc.encode('{"a":1,"b":"x","c":[true],"d":null}')))
  assert.equal(stats.type, "object")
  assert.equal(stats.length, 4)
  assert.deepEqual(stats.keys, ["a", "b", "c", "d"])
  assert.equal(stats.keyTypes.b, "string")
  assert.equal(stats.valueTypes.number, 1)
  const array = JSON.parse(api.json_stats(enc.encode('[1,2,"x"]')))
  assert.equal(array.type, "array")
  assert.equal(array.elementTypes.number, 2)
}
// json_paths: leaf enumeration, type tags, caps
{
  const paths = JSON.parse(
    api.json_paths(enc.encode('{"a":{"b":1},"c":[],"d":[{"e":"x"}],"e f":2}'), "{}"),
  )
  const rendered = paths.paths.map((entry) => `${entry.path}:${entry.type}`)
  for (const expected of [".a.b:number", ".c:array", ".d[0].e:string", '.["e f"]:number']) {
    assert.ok(rendered.includes(expected), `missing ${expected}`)
  }
  assert.equal(paths.truncated, false)
  const capped = JSON.parse(api.json_paths(enc.encode("[1,2,3]"), JSON.stringify({ limit: 2 })))
  assert.equal(capped.count, 2)
  assert.equal(capped.truncated, true)
}
// determinism across repeated calls
{
  const input = enc.encode('{"b":2,"a":[3,1,2]}')
  const options = opts(".a | sort")
  assert.equal(api.json_query(input, options), api.json_query(input, options))
}
// jaq JSON-superset extension values still serialize as strict JSON
{
  const result = query('b"ab"', opts("."))
  assert.deepEqual(result.results[0], { $bytes: "6162" })
  assert.deepEqual(query("1", opts("1 / 0")).results, [null])
}
// every response is schema_version 1 JSON, including errors
for (const doc of [
  api.json_query(enc.encode("1"), opts(".")),
  api.json_query(enc.encode("{"), opts(".")),
  api.json_validate(enc.encode("{")),
  api.json_stats(enc.encode("{}")),
  api.json_paths(enc.encode("[]"), "{}"),
]) {
  const parsed = JSON.parse(doc)
  assert.equal(parsed.schema_version, 1)
}
console.log("json-query WASM compatibility verified")
