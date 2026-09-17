import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const packed = new Uint8Array(await readFile(path.resolve(process.argv[3] ?? "")))
const expected = await readFile(path.resolve(process.argv[4] ?? ""))
const { createStaticUnpack } = await import(pathToFileURL(path.join(directory, "index.js")).href)
const runtime = await createStaticUnpack({
  locateFile: (file) => path.join(directory, file),
  mpressWasm: await readFile(path.join(directory, "mpress/turen_mpress_wasm_bg.wasm")),
})
const result = await runtime.unpackUpx(packed)
assert.deepEqual(Buffer.from(result.bytes), expected)
assert.equal(result.metadata.runnable, true)
console.log("static unpack package API verified")
