import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_goblin_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_goblin_wasm_bg.wasm")) })

const elf = new Uint8Array(64)
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
elf[16] = 2
elf[18] = 0x3e
elf[20] = 1
new DataView(elf.buffer).setBigUint64(24, 0x401000n, true)
elf[52] = 64

const result = JSON.parse(api.inspect(elf))
assert.equal(result.schemaVersion, 1)
assert.equal(result.format, "elf")
assert.equal(result.architecture, "x86_64")
assert.equal(result.bits, 64)
assert.equal(result.endian, "little")
assert.equal(result.entryPoint, "0x401000")
assert.deepEqual(result.sections, [])

assert.throws(() => api.inspect(new Uint8Array(8)), /too small/i)
console.log("Goblin WASM compatibility verified")
