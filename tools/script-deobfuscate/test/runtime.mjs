import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const bytes = (text) => new TextEncoder().encode(text)
export const sha256 = (value) => createHash("sha256").update(value).digest("hex")

export async function load(directory) {
  const wasm = await readFile(path.join(directory, "turen_script_deobfuscate_wasm_bg.wasm"))
  const module = await WebAssembly.compile(wasm)
  for (const entry of WebAssembly.Module.imports(module)) {
    assert.equal(entry.kind, "function", `unexpected import ${entry.module}.${entry.name}`)
    assert.ok(
      !/wasi|\bfs\b|network|socket|fetch|process|eval|function_constructor/i.test(`${entry.module}.${entry.name}`),
      "forbidden WASM host capability",
    )
    assert.match(
      entry.module,
      /^\.?\/?(?:.*\/)?turen_script_deobfuscate_wasm(?:_bg)?\.js$|^__wbindgen_placeholder__$/,
      "unexpected import module",
    )
  }
  // Read the standard binary memory section: JS reflection does not expose maxima.
  let offset = 8
  const leb = () => {
    let value = 0
    let shift = 0
    for (let count = 0; count < 5; count++) {
      const byte = wasm[offset++]
      assert.notEqual(byte, undefined, "truncated WASM LEB")
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
      shift += 7
    }
    assert.fail("oversized WASM LEB")
  }
  let memories = 0
  while (offset < wasm.length) {
    const section = wasm[offset++]
    const length = leb()
    const end = offset + length
    assert.ok(end <= wasm.length)
    if (section === 5) {
      memories = leb()
      assert.equal(memories, 1, "one bounded linear memory required")
      const flags = leb()
      assert.equal(flags, 1, "memory must have maximum and must not be shared/memory64")
      const minimum = leb()
      const maximum = leb()
      assert.ok(minimum <= maximum && maximum <= 4096, "memory exceeds 256 MiB")
    }
    offset = end
  }
  assert.equal(memories, 1)
  const api = await import(pathToFileURL(path.join(directory, "turen_script_deobfuscate_wasm.js")).href)
  await api.default({ module_or_path: wasm })
  return api
}

export function invoke(api, input, optionsJSON = "{}") {
  let raw
  try {
    raw = api.deobfuscate(input, optionsJSON)
  } catch (error) {
    // wasm-bindgen Result errors may carry the same structured report in Error.message.
    raw = typeof error === "string" ? error : error.message
  }
  assert.equal(typeof raw, "string", "ABI must return JSON text")
  assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024, "serialized report limit")
  const report = JSON.parse(raw)
  assert.equal(report.schema_version, 1)
  if (report.error !== undefined) {
    assert.equal(typeof report.error, "string")
    assert.ok(report.error.length > 0)
    assert.equal(typeof report.message, "string")
    assert.ok(Buffer.byteLength(report.message) <= 4096)
    return report
  }
  assert.equal(report.language, "js")
  assert.equal(report.input.bytes, input.length)
  assert.equal(report.input.sha256, sha256(input), "original input provenance")
  assert.equal(typeof report.code, "string")
  assert.ok(Buffer.byteLength(report.code) <= 2 * 1024 * 1024)
  assert.equal(typeof report.truncated, "boolean")
  assert.ok(Array.isArray(report.warnings))
  assert.ok(Array.isArray(report.transformations) && report.transformations.length <= 256)
  assert.ok(Array.isArray(report.payloads) && report.payloads.length <= 128)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (const entry of [...report.transformations, ...report.payloads]) {
    assert.equal(typeof entry.kind, "string")
    assert.ok(Number.isInteger(entry.start) && Number.isInteger(entry.end))
    assert.ok(entry.start >= 0 && entry.start < entry.end && entry.end <= input.length, "original byte span range")
    const original = input.subarray(entry.start, entry.end)
    decoder.decode(original) // Reject offsets splitting a multibyte code point.
    if (entry.source_sha256 !== undefined) assert.equal(entry.source_sha256, sha256(original))
    if (entry.sourceSpan?.sha256 !== undefined) assert.equal(entry.sourceSpan.sha256, sha256(original))
  }
  let payloadBytes = 0
  for (const payload of report.payloads) {
    assert.equal(typeof payload.code, "string")
    assert.ok(Buffer.byteLength(payload.code) <= 64 * 1024)
    assert.equal(payload.sha256, sha256(bytes(payload.code)), "payload SHA-256")
    payloadBytes += Buffer.byteLength(payload.code)
  }
  assert.ok(payloadBytes <= 256 * 1024)
  return report
}
