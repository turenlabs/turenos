import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_mpress_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_mpress_wasm_bg.wasm")) })

const fixture = makeFixture()
const probe = JSON.parse(api.probe(fixture))
assert.equal(probe.packer, "mpress")
assert.equal(probe.version, "2.12-2.19-lzmat")
assert.equal(probe.method, "lzmat")

const unpacked = api.unpack_mpress(fixture)
assert.equal(String.fromCharCode(...unpacked.slice(0, 2)), "MZ")
assert.equal(new DataView(unpacked.buffer).getUint32(0x80 + 24 + 16, true), 0x1010)
assert.deepEqual([...unpacked.slice(0x210, 0x214)], [0xde, 0xad, 0xbe, 0xef])
const metadata = JSON.parse(api.unpack_mpress_metadata(fixture))
assert.equal(metadata.entryPoint, "0x1010")
assert.equal(metadata.importsRebuilt, false)
assert.equal(metadata.runnable, false)
console.log("MPRESS analysis-grade WASM reconstruction verified")

function makeFixture() {
  const unpacked = new Uint8Array(0x1000)
  unpacked.set([0xde, 0xad, 0xbe, 0xef], 0x10)
  unpacked[0x107] = 0x35
  new DataView(unpacked.buffer).setInt32(0x224, -0x218, true)
  const packed = literalLzmat(unpacked)
  const packedRawSize = align(6 + packed.length, 0x200)
  const epRawOffset = 0x200 + packedRawSize
  const bytes = new Uint8Array(epRawOffset + 0x400)
  const view = new DataView(bytes.buffer)
  bytes.set([0x4d, 0x5a], 0)
  view.setUint32(0x3c, 0x80, true)
  bytes.set([0x50, 0x45, 0, 0], 0x80)
  view.setUint16(0x84, 0x14c, true)
  view.setUint16(0x86, 2, true)
  view.setUint16(0x94, 0xe0, true)
  view.setUint16(0x96, 0x0102, true)
  const optional = 0x98
  view.setUint16(optional, 0x10b, true)
  view.setUint32(optional + 16, 0x2000, true)
  view.setUint32(optional + 28, 0x400000, true)
  view.setUint32(optional + 32, 0x1000, true)
  view.setUint32(optional + 36, 0x200, true)
  view.setUint32(optional + 56, 0x3000, true)
  view.setUint32(optional + 60, 0x200, true)
  view.setUint32(optional + 92, 16, true)
  const sections = optional + 0xe0
  section(bytes, sections, ".MPRESS1", 0x1000, 0x1000, packedRawSize, 0x200, 0xe0000060)
  section(bytes, sections + 40, ".MPRESS2", 0x1000, 0x2000, 0x400, epRawOffset, 0xe0000060)
  view.setUint16(0x200, 1, true)
  view.setUint32(0x202, packed.length, true)
  bytes.set(packed, 0x206)
  const ep = epRawOffset
  view.setUint32(ep + 8, 0x29f, true)
  view.setInt32(ep + 0x2a5, 0x1000 - (0x2000 + 0x2a5), true)
  view.setInt32(ep + 0x2a1, 0x1100 - (0x2000 + 0x2a1 + 4), true)
  return bytes
}

function section(bytes, offset, name, virtualSize, virtualAddress, rawSize, rawOffset, flags) {
  bytes.set(new TextEncoder().encode(name).slice(0, 8), offset)
  const view = new DataView(bytes.buffer)
  view.setUint32(offset + 8, virtualSize, true)
  view.setUint32(offset + 12, virtualAddress, true)
  view.setUint32(offset + 16, rawSize, true)
  view.setUint32(offset + 20, rawOffset, true)
  view.setUint32(offset + 36, flags, true)
}

function literalLzmat(bytes) {
  const result = [bytes[0]]
  for (let offset = 1; offset < bytes.length; offset += 8) {
    result.push(0)
    result.push(...bytes.slice(offset, offset + 8))
  }
  return Uint8Array.from(result)
}

function align(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1)
}
