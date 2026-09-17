import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const packed = await readFile(path.resolve(process.argv[3] ?? ""))
const expected = await readFile(path.resolve(process.argv[4] ?? ""))
const createUpx = (await import(pathToFileURL(path.join(directory, "upx.mjs")).href)).default
const output = []
const runtime = await createUpx({
  noInitialRun: true,
  locateFile: (file) => path.join(directory, file),
  print: (line) => output.push(line),
  printErr: (line) => output.push(line),
})

runtime.FS.writeFile("/input", packed)
let status = 0
let failure
try {
  status = runtime.callMain(["-d", "-o", "/output", "/input"])
} catch (error) {
  status = error?.status ?? 1
  failure = error
}
assert.equal(status, 0, [output.join("\n"), failure?.stack ?? failure?.message ?? failure].filter(Boolean).join("\n"))
const actual = runtime.FS.readFile("/output")
assert.deepEqual(Buffer.from(actual), expected)
console.log("official UPX WASM decompression verified")
