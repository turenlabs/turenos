import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_stng_core_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_stng_core_wasm_bg.wasm")) })

const wide = [..."WideSecret"].flatMap((character) => [character.charCodeAt(0), 0])
const input = Uint8Array.from([
  ...new TextEncoder().encode("https://example.com\0SGVsbG8gd29ybGQh\0"),
  ...wide,
  0,
])
const result = JSON.parse(api.extract(input, 4, true, false, new Uint8Array()))
assert.equal(result.schemaVersion, 1)
assert.ok(result.strings.some((item) => item.value === "https://example.com" && item.kind === "url"))
assert.ok(result.strings.some((item) => item.value === "Hello world!" && item.method === "base64"))
assert.ok(result.strings.some((item) => item.value === "WideSecret" && item.method === "utf16le"))

const key = Uint8Array.of(0x23)
const encoded = Uint8Array.from(new TextEncoder().encode("xor-secret-value"), (byte) => byte ^ key[0])
const xor = JSON.parse(api.extract(encoded, 4, false, false, key))
assert.ok(xor.strings.some((item) => item.value === "xor-secret-value" && item.xorKey === "23"))
assert.throws(() => api.extract(new Uint8Array(), 4, false, false, new Uint8Array(65)), /64-byte/)
console.log("stng-core WASM compatibility verified")
