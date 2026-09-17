import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2])
const api = await import(`${pathToFileURL(path.join(directory, "turen_binwalk_scan_wasm.js")).href}?${Date.now()}`)
await api.default({ module_or_path: await fs.readFile(path.join(directory, "turen_binwalk_scan_wasm_bg.wasm")) })

const firmware = new Uint8Array(256)
firmware.set(new TextEncoder().encode("-rom1fs-"), 16)
new DataView(firmware.buffer).setUint32(24, 64)
firmware.set(new TextEncoder().encode("root\0"), 32)
firmware.set(new TextEncoder().encode("HDR0"), 128)
new DataView(firmware.buffer).setUint32(132, 28, true)
const report = JSON.parse(api.binwalk_scan(firmware, JSON.stringify({ maxFindings: 16 })))
assert.equal(report.schema_version, 1)
assert.deepEqual(
  report.findings.map((finding) => finding.signature),
  ["romfs", "broadcom-trx"],
)

const decoy = JSON.parse(api.binwalk_scan(new TextEncoder().encode("UBI# ANDROID! HDR0 hsqs"), "{}"))
assert.equal(decoy.findings.length, 0)

const streams = new Uint8Array(40)
for (let offset = 0; offset < streams.length; offset += 10) streams.set([0x1f, 0x8b, 0x08, 0], offset)
const truncated = JSON.parse(api.binwalk_scan(streams, JSON.stringify({ maxFindings: 2 })))
assert.equal(truncated.findings.length, 2)
assert.equal(truncated.truncated, true)

const oversized = JSON.parse(api.binwalk_scan(new Uint8Array(32 * 1024 * 1024 + 1), "{}"))
assert.equal(oversized.error, "input_too_large")
const oversizedOptions = JSON.parse(api.binwalk_scan(new Uint8Array([0]), "x".repeat(1025)))
assert.equal(oversizedOptions.error, "options_too_large")

const signatures = [
  fixture(96, (bytes, view) => {
    bytes.set(text("hsqs"))
    view.setUint16(28, 4, true)
    view.setBigUint64(40, 96n, true)
  }),
  fixture(12, (bytes, view) => {
    bytes.set([0x85, 0x19])
    view.setUint16(2, 0xe001, true)
    view.setUint32(4, 12, true)
  }),
  fixture(64, (bytes, view) => {
    bytes.set(text("UBI#"))
    bytes[4] = 1
    view.setUint32(16, 64)
    view.setUint32(20, 128)
  }),
  fixture(64, (bytes, view) => {
    bytes.set([0x45, 0x3d, 0xcd, 0x28])
    view.setUint32(4, 64, true)
  }),
  fixture(64, (bytes, view) => {
    bytes.set([0x27, 0x05, 0x19, 0x56])
    view.setUint32(12, 0)
  }),
  fixture(64, (bytes, view) => {
    bytes.set([0xd0, 0x0d, 0xfe, 0xed])
    view.setUint32(4, 64)
    view.setUint32(8, 40)
    view.setUint32(12, 48)
    view.setUint32(20, 17)
  }),
  fixture(64, (bytes, view) => {
    bytes.set(text("ANDROID!"))
    view.setUint32(36, 2048, true)
  }),
  fixture(28, (bytes, view) => {
    bytes.set(text("HDR0"))
    view.setUint32(4, 28, true)
  }),
  Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0]),
  Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]),
  Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]),
  Uint8Array.from([...text("BZh91AY&SY")]),
  Uint8Array.from([0x04, 0x22, 0x4d, 0x18, 0x40, 0x40, 0]),
  fixture(64, (bytes, view) => {
    bytes.set(text("-rom1fs-"))
    view.setUint32(8, 64)
    bytes.set(text("root\0"), 16)
  }),
  cpio(),
]
const expected = [
  "squashfs",
  "jffs2-node",
  "ubi-ec-header",
  "cramfs",
  "uboot-uimage",
  "devicetree-blob",
  "android-boot-image",
  "broadcom-trx",
  "gzip",
  "xz",
  "zstd",
  "bzip2",
  "lz4-frame",
  "romfs",
  "cpio-newc-entry",
]
assert.deepEqual(
  signatures.map((bytes) => JSON.parse(api.binwalk_scan(bytes, "{}")).findings[0]?.signature),
  expected,
)
console.log("binwalk scan verified")

function fixture(size, initialize) {
  const bytes = new Uint8Array(size)
  initialize(bytes, new DataView(bytes.buffer))
  return bytes
}

function text(value) {
  return new TextEncoder().encode(value)
}

function cpio() {
  const bytes = new Uint8Array(116)
  bytes.fill(0x30, 0, 110)
  bytes.set(text("070701"))
  bytes.set(text("00000000"), 54)
  bytes.set(text("00000002"), 94)
  bytes.set(text("x\0"), 110)
  return bytes
}
