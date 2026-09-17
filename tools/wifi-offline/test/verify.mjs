import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_wifi_offline_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_wifi_offline_wasm_bg.wasm")) })
const parsed = JSON.parse(api.analyze(new Uint8Array(24), "{}"))
assert.equal(parsed.schemaVersion, 1)
assert.ok("packetCount" in parsed.result || parsed.warnings.length > 0)
console.log("wifi-offline WASM compatibility verified")
