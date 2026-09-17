import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_firmware_formats_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_firmware_formats_wasm_bg.wasm")) })

let checks = 0
const ok = (...args) => { assert.ok(...args); checks += 1 }
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }
const text = (value) => new TextEncoder().encode(value)

function thrownCode(fn) {
  try {
    fn()
  } catch (error) {
    const parsed = JSON.parse(error.message)
    eq(parsed.schema_version, 1)
    ok(typeof parsed.error === "string" && parsed.error.length > 0)
    return parsed.error
  }
  throw new Error("expected an error")
}

function report(result) {
  const parsed = JSON.parse(result)
  eq(parsed.schema_version, 1)
  return parsed
}

// ---------------------------------------------------------------------------
// Fixture builders — every format here is small enough to write by hand.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let cell = i
    for (let bit = 0; bit < 8; bit += 1) cell = (cell & 1) ? (0xEDB88320 ^ (cell >>> 1)) : (cell >>> 1)
    table[i] = cell
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}
eq(crc32(text("123456789")), 0xCBF43926) // standard check value

function buildDtb() {
  const strings = text("compatible\0reg\0flag\0status\0")
  const off = { compatible: 0, reg: 11, flag: 15, status: 20 }
  const struct = []
  const u32 = (value) => struct.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  const align = () => { while (struct.length % 4) struct.push(0) }
  const begin = (name) => { u32(1); for (const ch of name) struct.push(ch.charCodeAt(0)); struct.push(0); align() }
  const end = () => u32(2)
  const prop = (name, data) => { u32(3); u32(data.length); u32(off[name]); struct.push(...data); align() }

  begin("")
  prop("compatible", text("turen,fixture\0turen,dummy\0"))
  prop("reg", [0x40, 0, 0, 0, 0, 0, 0x10, 0])
  prop("flag", [])
  begin("child@0")
  prop("status", text("okay\0"))
  end()
  end()
  u32(9) // FDT_END

  const rsvmapOff = 40
  const structOff = rsvmapOff + 32
  const stringsOff = structOff + struct.length
  const total = stringsOff + strings.length
  const out = []
  const w32 = (value) => out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  const w64 = (value) => { w32(Math.floor(value / 2 ** 32)); w32(value >>> 0) }
  w32(0xd00dfeed); w32(total); w32(structOff); w32(stringsOff); w32(rsvmapOff)
  w32(17); w32(16); w32(0); w32(strings.length); w32(struct.length)
  w64(0x80000000); w64(0x1000); w64(0); w64(0) // one memreserve + terminator
  out.push(...struct, ...strings)
  return new Uint8Array(out)
}

function buildUimage(data, { corruptHeader = false, corruptData = false } = {}) {
  const header = new Uint8Array(64)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x27051956)
  view.setUint32(8, 0x66000100)
  view.setUint32(12, data.length)
  view.setUint32(16, 0x80008000)
  view.setUint32(20, 0x80008000)
  view.setUint32(24, corruptData ? crc32(data) ^ 1 : crc32(data))
  header.set([5, 2, 2, 1], 28) // linux, arm, kernel, gzip
  header.set(text("Linux-6.1"), 32)
  const zeroed = new Uint8Array(header); zeroed.fill(0, 4, 8)
  view.setUint32(4, corruptHeader ? crc32(zeroed) ^ 1 : crc32(zeroed))
  const out = new Uint8Array(64 + data.length)
  out.set(header); out.set(data, 64)
  return out
}

function buildEnv(entries, { redundant = false, terminate = true, littleEndian = true } = {}) {
  const data = []
  for (const [key, value] of entries) data.push(...text(`${key}=${value}`), 0)
  if (terminate) data.push(0)
  const checksum = crc32(new Uint8Array(data))
  const out = []
  const stored = littleEndian
    ? [checksum & 255, (checksum >>> 8) & 255, (checksum >>> 16) & 255, checksum >>> 24]
    : [checksum >>> 24, (checksum >>> 16) & 255, (checksum >>> 8) & 255, checksum & 255]
  out.push(...stored)
  if (redundant) out.push(1)
  out.push(...data)
  return new Uint8Array(out)
}

function ihexLine(count, address, rtype, data = []) {
  const bytes = [count, (address >> 8) & 255, address & 255, rtype, ...data]
  const checksum = (-bytes.reduce((a, b) => a + b, 0)) & 255
  const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, "0")
  return `:${hex(count, 2)}${hex(address, 4)}${hex(rtype, 2)}${data.map((b) => hex(b, 2)).join("")}${hex(checksum, 2)}\n`
}

function srecLine(rtype, address, data = []) {
  const alen = { 0: 2, 1: 2, 5: 2, 9: 2, 2: 3, 6: 3, 8: 3, 3: 4, 7: 4 }[rtype] ?? 2
  const count = alen + data.length + 1
  const addrBytes = []
  for (let shift = (alen - 1) * 8; shift >= 0; shift -= 8) addrBytes.push((address >> shift) & 255)
  const checksum = ~[count, ...addrBytes, ...data].reduce((a, b) => a + b, 0) & 255
  const hex = (value) => value.toString(16).toUpperCase().padStart(2, "0")
  return `S${rtype}${hex(count)}${[...addrBytes, ...data, checksum].map(hex).join("")}\n`
}

function buildSparse(chunks, { blockSize = 4096 } = {}) {
  // chunks: [kind, blocks, payload]
  const totalBlocks = chunks.reduce((sum, [kind, blocks]) => sum + (kind === 0xCAC4 ? 0 : blocks), 0)
  const out = []
  const w16 = (v) => out.push(v & 255, (v >> 8) & 255)
  const w32 = (v) => out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255)
  w32(0xED26FF3A); w16(1); w16(0); w16(28); w16(12)
  w32(blockSize); w32(totalBlocks); w32(chunks.length); w32(0)
  for (const [kind, blocks, payload] of chunks) {
    w16(kind); w16(0); w32(blocks); w32(12 + payload.length)
    out.push(...payload)
  }
  return new Uint8Array(out)
}

// ---------------------------------------------------------------------------
// dtb_decompile
// ---------------------------------------------------------------------------

const dtb = buildDtb()
{
  const result = report(api.dtb_decompile(dtb, "{}"))
  eq(result.kind, "dtb")
  eq(result.version, 17)
  eq(result.node_count, 2)
  eq(result.property_count, 4)
  eq(result.truncated, false)
  eq(result.memory_reservations, [{ address: "0x80000000", size: "0x1000" }])
  ok(result.dts.startsWith("/dts-v1/;"))
  ok(result.dts.includes("/memreserve/ 0x0000000080000000 0x0000000000001000;"))
  ok(result.dts.includes("/ {"))
  ok(result.dts.includes('compatible = "turen,fixture", "turen,dummy";'))
  ok(result.dts.includes("reg = <0x40000000 0x1000>;"))
  ok(result.dts.includes("\tflag;"))
  ok(result.dts.includes("child@0 {"))
  ok(result.dts.includes('status = "okay";'))
  ok(result.dts.endsWith("};\n"))

  eq(thrownCode(() => api.dtb_decompile(text("not a dtb"), "{}")), "truncated")
  const badMagic = new Uint8Array(dtb); badMagic[0] = 0
  eq(thrownCode(() => api.dtb_decompile(badMagic, "{}")), "bad_magic")
  const shortTotal = new Uint8Array(dtb)
  new DataView(shortTotal.buffer).setUint32(4, 10_000_000)
  eq(thrownCode(() => api.dtb_decompile(shortTotal, "{}")), "truncated")
  const badStruct = new Uint8Array(dtb)
  new DataView(badStruct.buffer).setUint32(8, 9_000_000)
  eq(thrownCode(() => api.dtb_decompile(badStruct, "{}")), "malformed")
  const badName = new Uint8Array(dtb)
  const structOff = new DataView(dtb.buffer).getUint32(8)
  new DataView(badName.buffer).setUint32(structOff + 16, 0x00FFFFFF) // first PROP nameoff
  eq(thrownCode(() => api.dtb_decompile(badName, "{}")), "malformed")

  const capped = report(api.dtb_decompile(dtb, '{"maxOutputBytes":1024}'))
  eq(capped.truncated, true)
  ok(capped.dts.length <= 1024)
  eq(api.dtb_decompile(dtb, "{}"), api.dtb_decompile(dtb, "{}")) // deterministic
}

// ---------------------------------------------------------------------------
// uimage_inspect
// ---------------------------------------------------------------------------

const payload = text("fake kernel bytes")
const uimage = buildUimage(payload)
{
  const result = report(api.uimage_inspect(uimage, "{}"))
  eq(result.kind, "uimage")
  eq(result.name, "Linux-6.1")
  eq(result.timestamp, 0x66000100)
  eq(result.load_address, "0x80008000")
  eq(result.entry_point, "0x80008000")
  eq(result.data_size, payload.length)
  eq(result.os_name, "linux")
  eq(result.arch_name, "arm")
  eq(result.type_name, "kernel")
  eq(result.compression_name, "gzip")
  eq(result.header_crc.valid, true)
  eq(result.data_crc.valid, true)
  eq(result.data_present, true)
  eq(result.trailing_bytes, 0)

  eq(report(api.uimage_inspect(buildUimage(payload, { corruptHeader: true }), "{}")).header_crc.valid, false)
  eq(report(api.uimage_inspect(buildUimage(payload, { corruptData: true }), "{}")).data_crc.valid, false)

  const truncated = report(api.uimage_inspect(uimage.slice(0, 70), "{}"))
  eq(truncated.data_present, false)
  eq(truncated.data_crc.valid, null)
  ok(truncated.warnings[0].includes("data_truncated"))

  eq(thrownCode(() => api.uimage_inspect(text("tiny"), "{}")), "truncated")
  const badMagic = new Uint8Array(uimage); badMagic[0] = 0
  eq(thrownCode(() => api.uimage_inspect(badMagic, "{}")), "bad_magic")
}

// ---------------------------------------------------------------------------
// uboot_env_parse
// ---------------------------------------------------------------------------

{
  const env = buildEnv([["bootcmd", "run distro_bootcmd"], ["baudrate", "115200"]])
  const result = report(api.uboot_env_parse(env, "{}"))
  eq(result.kind, "uboot-env")
  eq(result.redundancy, "none")
  eq(result.crc.valid, true)
  eq(result.crc.endianness, "little")
  eq(result.entry_count, 2)
  eq(result.entries[0], { key: "bootcmd", value: "run distro_bootcmd" })
  eq(result.terminated, true)

  const redundant = buildEnv([["a", "b"]], { redundant: true })
  const parsed = report(api.uboot_env_parse(redundant, "{}"))
  eq(parsed.redundancy, "redundant")
  eq(parsed.flag, 1)
  eq(parsed.data_offset, 5)
  eq(parsed.crc.valid, true)
  eq(report(api.uboot_env_parse(redundant, '{"redundant":false}')).crc.valid, false)

  const corrupt = new Uint8Array(env); corrupt[6] ^= 0xFF
  const badCrc = report(api.uboot_env_parse(corrupt, "{}"))
  eq(badCrc.crc.valid, false)
  eq(badCrc.crc.endianness, null)
  eq(badCrc.entry_count, 2)

  const unterminated = buildEnv([["k", "v"]], { terminate: false })
  eq(report(api.uboot_env_parse(unterminated, "{}")).terminated, false)

  const many = buildEnv(Array.from({ length: 20 }, (_, i) => [`k${i}`, `v${i}`]))
  const capped = report(api.uboot_env_parse(many, '{"maxEntries":5}'))
  eq(capped.entry_count, 5)
  eq(capped.truncated, true)

  eq(thrownCode(() => api.uboot_env_parse(new Uint8Array(2), "{}")), "truncated")
}

// ---------------------------------------------------------------------------
// ihex_parse / ihex_flatten
// ---------------------------------------------------------------------------

const ihexText =
  ihexLine(2, 0, 4, [0x08, 0x00]) +           // ext linear 0x08000000
  ihexLine(4, 0x0100, 0, [0xDE, 0xAD, 0xBE, 0xEF]) +
  ihexLine(4, 0x0200, 0, [1, 2, 3, 4]) +      // gap 0x104..0x200
  ihexLine(4, 0, 5, [0x08, 0x00, 0x01, 0x00]) +
  ihexLine(0, 0, 1)

{
  const result = report(api.ihex_parse(text(ihexText), "{}"))
  eq(result.kind, "ihex")
  eq(result.record_count, 5)
  eq(result.data_record_count, 2)
  eq(result.data_bytes, 8)
  eq(result.eof, true)
  eq(result.invalid_checksums, 0)
  eq(result.start_address, "0x8000100")
  eq(result.min_address, "0x8000100")
  eq(result.max_address, "0x8000204")
  eq(result.range_count, 2)
  eq(result.gaps, [{ start: "0x8000104", end: "0x8000200", size: 0xfc }])
  eq(result.records.map((r) => r.type), ["extended_linear", "data", "data", "start_linear", "eof"])
  ok(result.records.every((r) => r.checksum_valid))

  // flatten: image covers [min, max], gap filled with 0xFF
  const image = api.ihex_flatten(text(ihexText), "{}")
  eq(image.length, 0x104)
  eq(Array.from(image.slice(0, 4)), [0xDE, 0xAD, 0xBE, 0xEF])
  eq(Array.from(image.slice(0x100)), [1, 2, 3, 4])
  ok(image.slice(4, 0x100).every((b) => b === 0xFF))
  ok(api.ihex_flatten(text(ihexText), '{"fill":0}').slice(4, 0x100).every((b) => b === 0))

  // bad checksum: listed but flagged; flatten fails unless ignoreChecksums
  const badSum = ihexText.replace("DEADBEEF", "DEADBEEE")
  const flagged = report(api.ihex_parse(text(badSum), "{}"))
  eq(flagged.invalid_checksums, 1)
  eq(flagged.records[1].checksum_valid, false)
  eq(thrownCode(() => api.ihex_flatten(text(badSum), "{}")), "checksum_mismatch")
  eq(api.ihex_flatten(text(badSum), '{"ignoreChecksums":true}').length, 0x104)

  // malformed lines
  for (const bad of ["no colon\n", ":0Z0100000000\n", ":10010000214601\n", ":0400000201\n", ":0500010203\n"]) {
    eq(thrownCode(() => api.ihex_parse(text(bad), "{}")), "invalid_record", bad)
    eq(thrownCode(() => api.ihex_flatten(text(bad), "{}")), "invalid_record", bad)
  }

  // output cap: span wider than the limit is an error, not an allocation
  const wide = ihexLine(1, 0, 0, [0xAA]) + ihexLine(2, 0, 4, [0xFF, 0xFF]) + ihexLine(1, 0xFFFF, 0, [0xBB])
  eq(thrownCode(() => api.ihex_flatten(text(wide), "{}")), "output_too_large")
  eq(thrownCode(() => api.ihex_flatten(text(ihexText), '{"maxOutputBytes":2}')), "output_too_large")

  // empty image
  eq(api.ihex_flatten(text(ihexLine(0, 0, 1)), "{}").length, 0)
  eq(api.ihex_parse(text(ihexText), "{}"), api.ihex_parse(text(ihexText), "{}"))
}

// ---------------------------------------------------------------------------
// srec_parse / srec_flatten
// ---------------------------------------------------------------------------

const srecText =
  srecLine(0, 0, Array.from(text("HDR"))) +
  srecLine(1, 0x0100, [0xDE, 0xAD, 0xBE, 0xEF]) +
  srecLine(1, 0x0200, [1, 2, 3, 4]) +
  srecLine(5, 2) +
  srecLine(9, 0x0100)

{
  const result = report(api.srec_parse(text(srecText), "{}"))
  eq(result.kind, "srec")
  eq(result.record_count, 5)
  eq(result.data_record_count, 2)
  eq(result.header, "HDR")
  eq(result.start_address, "0x100")
  eq(result.start_address_kind, "s9")
  eq(result.count_check, { declared: 2, actual: 2, valid: true })
  eq(result.gap_count, 1)
  eq(result.min_address, "0x100")
  eq(result.max_address, "0x204")

  const image = api.srec_flatten(text(srecText), "{}")
  eq(image.length, 0x104)
  eq(Array.from(image.slice(0, 4)), [0xDE, 0xAD, 0xBE, 0xEF])
  eq(Array.from(image.slice(0x100)), [1, 2, 3, 4])

  const mismatch = report(api.srec_parse(text(srecText.replace(srecLine(5, 2), srecLine(5, 5))), "{}"))
  eq(mismatch.count_check, { declared: 5, actual: 2, valid: false })
  ok(mismatch.warnings.some((w) => w.includes("count_mismatch")))

  for (const bad of ["X1130000\n", "S100000\n", "SZ04000000\n", "S10F\n"]) {
    eq(thrownCode(() => api.srec_parse(text(bad), "{}")), "invalid_record", bad)
  }
  const badSum = srecText.replace("DEADBEEF", "DFADBEEF")
  eq(thrownCode(() => api.srec_flatten(text(badSum), "{}")), "checksum_mismatch")
  ok(api.srec_flatten(text(badSum), '{"ignoreChecksums":true}').length === 0x104)

  // S3 32-bit addressing
  const wide = report(api.srec_parse(text(srecLine(3, 0x12345678, [0xAA])), "{}"))
  eq(wide.min_address, "0x12345678")
  eq(Array.from(api.srec_flatten(text(srecLine(3, 0x12345678, [0xAA])), "{}")), [0xAA])
  eq(api.srec_parse(text(srecText), "{}"), api.srec_parse(text(srecText), "{}"))
}

// ---------------------------------------------------------------------------
// android_sparse_parse / android_sparse_expand
// ---------------------------------------------------------------------------

const rawBlock = new Array(4096).fill(0x41)
const fillPattern = [0x11, 0x22, 0x33, 0x44]
const expectedExpanded = new Uint8Array(16384)
expectedExpanded.fill(0x41, 0, 4096)
for (let i = 4096; i < 12288; i += 1) expectedExpanded[i] = fillPattern[i % 4]
const sparseBody = [
  [0xCAC1, 1, rawBlock],
  [0xCAC2, 2, fillPattern],
  [0xCAC3, 1, []],
]
const sparseCrc = crc32(expectedExpanded)
const sparse = buildSparse([...sparseBody, [0xCAC4, 0, [sparseCrc & 255, (sparseCrc >> 8) & 255, (sparseCrc >> 16) & 255, sparseCrc >>> 24]]])

{
  const result = report(api.android_sparse_parse(sparse, "{}"))
  eq(result.kind, "android-sparse")
  eq(result.version, { major: 1, minor: 0 })
  eq(result.block_size, 4096)
  eq(result.total_blocks, 4)
  eq(result.chunk_count, 4)
  eq(result.expanded_bytes, "16384")
  eq(result.chunks.map((c) => c.type), ["raw", "fill", "dont_care", "crc32"])
  eq(result.chunks[0].output_bytes, "4096")
  eq(result.crc.valid, true)

  const expanded = api.android_sparse_expand(sparse, "{}")
  eq(expanded, expectedExpanded)

  // crc mismatch: expand errors, parse reports valid:false
  const corrupt = new Uint8Array(sparse); corrupt[corrupt.length - 1] ^= 0xFF
  eq(thrownCode(() => api.android_sparse_expand(corrupt, "{}")), "crc_mismatch")
  eq(report(api.android_sparse_parse(corrupt, "{}")).crc.valid, false)

  // malformed inputs
  eq(thrownCode(() => api.android_sparse_parse(text("short"), "{}")), "truncated")
  const badMagic = new Uint8Array(sparse); badMagic[0] = 0
  eq(thrownCode(() => api.android_sparse_parse(badMagic, "{}")), "bad_magic")
  eq(thrownCode(() => api.android_sparse_parse(sparse.slice(0, sparse.length - 10), "{}")), "truncated")
  const unknown = new Uint8Array(sparse); unknown[28] = 0x99; unknown[29] = 0x99
  eq(thrownCode(() => api.android_sparse_parse(unknown, "{}")), "unknown_chunk")
  const shortRaw = buildSparse([[0xCAC1, 2, rawBlock]])
  eq(thrownCode(() => api.android_sparse_parse(shortRaw, "{}")), "malformed")

  // output cap: declared expansion is checked before allocation
  const huge = buildSparse([[0xCAC2, 40_000, fillPattern]]) // 163,840,000 bytes
  eq(thrownCode(() => api.android_sparse_expand(huge, "{}")), "output_too_large")
  eq(report(api.android_sparse_parse(huge, "{}")).expanded_bytes, "163840000")

  // block count mismatch is a warning, not an error
  const miscount = new Uint8Array(buildSparse([[0xCAC1, 1, rawBlock]]))
  new DataView(miscount.buffer).setUint32(16, 99, true)
  ok(report(api.android_sparse_parse(miscount, "{}")).warnings.some((w) => w.includes("block_count_mismatch")))

  eq(api.android_sparse_expand(sparse, "{}"), api.android_sparse_expand(sparse, "{}"))
}

// ---------------------------------------------------------------------------
// Shared limits
// ---------------------------------------------------------------------------

const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
for (const op of [api.dtb_decompile, api.uimage_inspect, api.uboot_env_parse, api.ihex_parse, api.srec_parse, api.android_sparse_parse]) {
  eq(thrownCode(() => op(oversized, "{}")), "input_too_large")
}
eq(thrownCode(() => api.ihex_flatten(oversized, "{}")), "input_too_large")
eq(thrownCode(() => api.android_sparse_expand(oversized, "{}")), "input_too_large")

const bigOptions = `{"pad":"${" ".repeat(4096)}"}`
eq(thrownCode(() => api.dtb_decompile(dtb, bigOptions)), "options_too_large")
eq(thrownCode(() => api.ihex_parse(text(ihexText), bigOptions)), "options_too_large")
eq(thrownCode(() => api.ihex_flatten(text(ihexText), bigOptions)), "options_too_large")

for (const bad of ["{", "not json", "[1,2]", "null", "42"]) {
  eq(thrownCode(() => api.ihex_parse(text(ihexText), bad)), "invalid_options", bad)
}
eq(thrownCode(() => api.ihex_flatten(text(ihexText), '{"fill":"x"}')), "invalid_options")
eq(thrownCode(() => api.ihex_flatten(text(ihexText), '{"ignoreChecksums":1}')), "invalid_options")
ok(api.ihex_parse(text(ihexText), '{"futureOption":123}').length > 0)
ok(api.ihex_parse(text(ihexText), "").length > 0)
ok(api.ihex_parse(text(ihexText), "   ").length > 0)

// determinism across the JSON-returning ops
eq(api.dtb_decompile(dtb, "{}"), api.dtb_decompile(dtb, "{}"))
eq(api.uimage_inspect(uimage, "{}"), api.uimage_inspect(uimage, "{}"))
eq(api.uboot_env_parse(buildEnv([["a", "b"]]), "{}"), api.uboot_env_parse(buildEnv([["a", "b"]]), "{}"))
eq(api.android_sparse_parse(sparse, "{}"), api.android_sparse_parse(sparse, "{}"))

console.log(`firmware-formats WASM verified (${checks} checks)`)
