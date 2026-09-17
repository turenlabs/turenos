import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_windows_artifacts_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_windows_artifacts_wasm_bg.wasm")) })
const parsed = JSON.parse(api.analyze(new TextEncoder().encode("not-an-artifact"), "{}"))
assert.equal(parsed.schemaVersion, 1)
assert.equal(parsed.result.kind, "unknown")
console.log("windows-artifacts WASM compatibility verified")
