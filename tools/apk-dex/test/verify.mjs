// Verifies the real apk-dex WASM build (pkg or packaged dist) — no mocks.
// Fixtures are fabricated byte-by-byte in JS: a binary AXML document, a
// minimal DEX, a resources.arsc, and ZIP/APK containers built by hand
// (stored + deflateRaw entries, plus a spliced APK v2 signing block).
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import zlib from "node:zlib"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_apk_dex_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_apk_dex_wasm_bg.wasm")) })

const OPTS = "{}"
const ok = (text) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1, text)
  assert.equal(value.error, undefined, text)
  return value
}
const err = (text, code) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1, text)
  assert.equal(value.error, code, text)
}

// ---------------------------------------------------------------------------
// byte builders
// ---------------------------------------------------------------------------

const te = new TextEncoder()
const str = (s) => te.encode(s)

function Writer() {
  const parts = []
  const w = {
    u8(v) { parts.push(Uint8Array.of(v & 0xff)); return w },
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); parts.push(b); return w },
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); parts.push(b); return w },
    u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); parts.push(b); return w },
    bytes(b) { parts.push(b instanceof Uint8Array ? b : Uint8Array.from(b)); return w },
    get len() { return parts.reduce((n, p) => n + p.length, 0) },
    build() { const out = new Uint8Array(w.len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out },
  }
  return w
}

function uleb(v) {
  const out = []
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return out
}

// ---- binary AXML ----

function stringPool(strings) {
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const enc = strings.map((s) => {
    const b = str(s)
    const e = []
    const chars = [...s].length
    if (chars >= 0x80) e.push(0x80 | (chars >> 8), chars & 0xff)
    else e.push(chars)
    if (b.length >= 0x80) e.push(0x80 | (b.length >> 8), b.length & 0xff)
    else e.push(b.length)
    return [...e, ...b, 0]
  })
  const dataLen = enc.reduce((n, e) => n + e.length, 0)
  const size = stringsStart + ((dataLen + 3) & ~3)
  const w = Writer()
  w.u16(0x0001).u16(headerSize).u32(size)
  w.u32(strings.length).u32(0).u32(0x100).u32(stringsStart).u32(0)
  let rel = 0
  for (const e of enc) { w.u32(rel); rel += e.length }
  for (const e of enc) w.bytes(e)
  while (w.len < size) w.u8(0)
  return w.build()
}

function node(type, body) {
  const w = Writer()
  w.u16(type).u16(16).u32(16 + body.length)
  w.u32(1).u32(0xffffffff)
  w.bytes(body)
  return w.build()
}

function startElement(ns, name, attrs) {
  const w = Writer()
  w.u32(ns).u32(name).u16(20).u16(20).u16(attrs.length).u16(0).u16(0).u16(0)
  for (const [aNs, aName, aRaw, aType, aData] of attrs) {
    w.u32(aNs).u32(aName).u32(aRaw).u16(8).u8(0).u8(aType).u32(aData)
  }
  return node(0x0102, w.build())
}

function endElement(ns, name) {
  const w = Writer()
  w.u32(ns).u32(name)
  return node(0x0103, w.build())
}

const AXML_STRINGS = [
  "manifest", "uses-sdk", "application", "activity",
  "http://schemas.android.com/apk/res/android", "android",
  "package", "name", "versionCode", "minSdkVersion", "exported",
  "com.example.app", ".MainActivity",
]

function buildAxml() {
  const NO = 0xffffffff
  const w = Writer()
  const parts = [stringPool(AXML_STRINGS)]
  // resource map
  const resIds = [0, 0, 0, 0, 0, 0, 0, 0x01010003, 0x0101021b, 0x0101020c, 0x01010010, 0, 0]
  const rm = Writer()
  rm.u16(0x0180).u16(8).u32(8 + resIds.length * 4)
  for (const id of resIds) rm.u32(id)
  parts.push(rm.build())
  // xmlns:android
  parts.push(node(0x0100, Writer().u32(5).u32(4).build()))
  parts.push(startElement(NO, 0, [[NO, 6, 11, 0x03, 11], [4, 8, NO, 0x10, 33]]))
  parts.push(startElement(NO, 1, [[4, 9, NO, 0x10, 21]]))
  parts.push(endElement(NO, 1))
  parts.push(startElement(NO, 2, []))
  parts.push(startElement(NO, 3, [[4, 7, 12, 0x03, 12], [4, 10, NO, 0x12, 1]]))
  parts.push(endElement(NO, 3))
  parts.push(endElement(NO, 2))
  parts.push(endElement(NO, 0))
  parts.push(node(0x0101, Writer().u32(5).u32(4).build()))
  const body = parts.reduce((n, p) => n + p.length, 0)
  w.u16(0x0003).u16(8).u32(8 + body)
  for (const p of parts) w.bytes(p)
  return w.build()
}

// ---- DEX ----

const DEX_STRINGS = [
  "Lcom/example/app/MainActivity;", "Ljava/lang/Object;", "Landroid/app/Activity;",
  "MainActivity.java", "V", "VL", "onCreate", "<init>", "Landroid/os/Bundle;",
  "Ljava/lang/reflect/Method;", "Ljavax/crypto/Cipher;", "/system/bin/su",
  "Ldalvik/system/DexClassLoader;", "loadClass", "Ljava/lang/Runtime;", "exec",
  "I", "version",
]

function buildDex() {
  const NO = 0xffffffff
  const types = [0, 1, 2, 8, 4, 16, 9, 10, 12, 14]
  const protos = [[4, 4, 0], [5, 4, NO]] // params_off patched below
  const fields = [[0, 5, 17]]
  const methods = [[0, 0, 7], [0, 1, 6], [8, 0, 13], [9, 0, 15]]

  const header = 0x70
  const stringIdsOff = header
  const typeIdsOff = stringIdsOff + DEX_STRINGS.length * 4
  const protoIdsOff = typeIdsOff + types.length * 4
  const fieldIdsOff = protoIdsOff + protos.length * 12
  const methodIdsOff = fieldIdsOff + fields.length * 8
  const classDefsOff = methodIdsOff + methods.length * 8
  const dataOff = classDefsOff + 2 * 32

  const data = []
  const stringOffsets = []
  for (const s of DEX_STRINGS) {
    stringOffsets.push(dataOff + data.length)
    data.push(...uleb([...s].length), ...str(s), 0)
  }
  while ((data.length % 4) !== 0) data.push(0)
  const paramsOff = dataOff + data.length
  const dv = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return [...b] }
  const dv2 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return [...b] }
  data.push(...dv(1), ...dv2(3))
  while ((data.length % 4) !== 0) data.push(0)

  const classData0 = dataOff + data.length
  data.push(...uleb(1), ...uleb(0), ...uleb(1), ...uleb(1))
  data.push(...uleb(0), ...uleb(0x9))
  data.push(...uleb(0), ...uleb(0x10001), ...uleb(0))
  data.push(...uleb(1), ...uleb(0x1), ...uleb(0))

  const classData1 = dataOff + data.length
  data.push(...uleb(0), ...uleb(0), ...uleb(1), ...uleb(0))
  data.push(...uleb(2), ...uleb(0x109), ...uleb(0))
  while ((data.length % 4) !== 0) data.push(0)

  const mapOff = dataOff + data.length
  const mapItems = [
    [0x0000, 1, 0], [0x0001, DEX_STRINGS.length, stringIdsOff], [0x0002, types.length, typeIdsOff],
    [0x0003, protos.length, protoIdsOff], [0x0004, fields.length, fieldIdsOff],
    [0x0005, methods.length, methodIdsOff], [0x0006, 2, classDefsOff],
    [0x1001, 1, paramsOff], [0x2002, DEX_STRINGS.length, dataOff],
    [0x2000, 2, classData0], [0x1000, 1, mapOff],
  ]
  data.push(...dv(mapItems.length))
  for (const [t, size, off] of mapItems) data.push(...dv2(t), ...dv2(0), ...dv(size), ...dv(off))

  const fileSize = dataOff + data.length
  const w = Writer()
  w.bytes(str("dex\n035\0")).u32(0xdeadbeef).bytes(new Uint8Array(20).fill(0x11))
  w.u32(fileSize).u32(0x70).u32(0x12345678).u32(0).u32(0).u32(mapOff)
  w.u32(DEX_STRINGS.length).u32(stringIdsOff)
  w.u32(types.length).u32(typeIdsOff)
  w.u32(protos.length).u32(protoIdsOff)
  w.u32(fields.length).u32(fieldIdsOff)
  w.u32(methods.length).u32(methodIdsOff)
  w.u32(2).u32(classDefsOff)
  w.u32(data.length).u32(dataOff)
  for (const o of stringOffsets) w.u32(o)
  for (const t of types) w.u32(t)
  for (const [i, [shorty, ret, params]] of protos.entries()) w.u32(shorty).u32(ret).u32(i === 1 ? paramsOff : params)
  for (const [c, t, n] of fields) w.u16(c).u16(t).u32(n)
  for (const [c, p, n] of methods) w.u16(c).u16(p).u32(n)
  w.u32(0).u32(1).u32(2).u32(0).u32(3).u32(0).u32(classData0).u32(0)
  w.u32(8).u32(1).u32(1).u32(0).u32(NO).u32(0).u32(classData1).u32(0)
  w.bytes(Uint8Array.from(data))
  return w.build()
}

// ---- resources.arsc ----

function buildArsc() {
  const w = Writer()
  w.u16(0x0200).u16(288).u32(288)
  w.u32(0x7f)
  const name = "com.example.app"
  for (let i = 0; i < 128; i++) w.u16(i < name.length ? name.charCodeAt(i) : 0)
  for (let i = 0; i < 5; i++) w.u32(0)
  const pkg = w.build()
  const t = Writer()
  t.u16(0x0002).u16(12).u32(12 + pkg.length)
  t.u32(1)
  t.bytes(pkg)
  return t.build()
}

// ---- ZIP/APK by hand ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// entries: [{name, data(Uint8Array), method: 0|8}]
function buildZip(entries) {
  const out = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = str(e.name)
    const payload = e.method === 8 ? new Uint8Array(zlib.deflateRawSync(e.data)) : e.data
    const crc = crc32(e.data)
    const local = Writer()
    local.u32(0x04034b50).u16(20).u16(0).u16(e.method).u16(0).u16(0)
      .u32(crc).u32(payload.length).u32(e.data.length)
      .u16(name.length).u16(0).bytes(name)
    const lh = local.build()
    out.push(lh, payload)
    const central = Writer()
    central.u32(0x02014b50).u16(20).u16(20).u16(0).u16(e.method).u16(0).u16(0)
      .u32(crc).u32(payload.length).u32(e.data.length)
      .u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(name)
    centrals.push(central.build())
    offset += lh.length + payload.length
  }
  const cdStart = offset
  let cdSize = 0
  for (const c of centrals) { out.push(c); cdSize += c.length }
  const eocd = Writer()
  eocd.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length)
    .u32(cdSize).u32(cdStart).u16(0)
  out.push(eocd.build())
  const total = out.reduce((n, p) => n + p.length, 0)
  const zip = new Uint8Array(total)
  let pos = 0
  for (const p of out) { zip.set(p, pos); pos += p.length }
  return zip
}

function buildApk() {
  return buildZip([
    { name: "AndroidManifest.xml", data: buildAxml(), method: 8 },
    { name: "classes.dex", data: buildDex(), method: 0 },
    { name: "classes2.dex", data: buildDex(), method: 0 },
    { name: "resources.arsc", data: buildArsc(), method: 0 },
    { name: "META-INF/CERT.SF", data: str("Signature-Version: 1.0\r\n"), method: 0 },
    { name: "META-INF/CERT.RSA", data: Uint8Array.from([0x30, 0x82, ...str("fake-cert")]), method: 0 },
  ])
}

function buildApkSigned() {
  const zip = buildApk()
  // EOCD sits at the end (no comment): last 22 bytes.
  const eocd = zip.length - 22
  const view = new DataView(zip.buffer)
  const cdOffset = view.getUint32(eocd + 16, true)
  const pair = Writer().u64(9).u32(0x7109871a).bytes(str("v2sig")).build()
  const blockSize = 8 + pair.length + 8 + 16
  const block = Writer()
    .u64(blockSize - 8).bytes(pair).u64(blockSize - 8).bytes(str("APK Sig Block 42"))
    .build()
  const out = new Uint8Array(zip.length + block.length)
  out.set(zip.subarray(0, cdOffset), 0)
  out.set(block, cdOffset)
  out.set(zip.subarray(cdOffset), cdOffset + block.length)
  new DataView(out.buffer).setUint32(eocd + 16 + block.length, cdOffset + block.length, true)
  return out
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

const axml = buildAxml()
const dex = buildDex()
const apk = buildApk()
const apkSigned = buildApkSigned()

// axml_decode
{
  const r = ok(api.axml_decode(axml, OPTS))
  assert.equal(r.kind, "axml")
  assert.equal(r.elements, 4)
  assert.equal(r.attributes, 5)
  assert.ok(r.xml.includes('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app" android:versionCode="33">'), r.xml)
  assert.ok(r.xml.includes('<uses-sdk android:minSdkVersion="21">'), r.xml)
  assert.ok(r.xml.includes('<activity android:name=".MainActivity" android:exported="true">'), r.xml)
  assert.ok(r.xml.includes("</manifest>"), r.xml)
  assert.equal(r.namespaces[0].prefix, "android")
  assert.equal(r.string_pool.count, 13)
  assert.equal(r.string_pool.utf8, true)

  // malformed
  err(api.axml_decode(str("not xml at all"), OPTS), "bad_magic")
  err(api.axml_decode(new Uint8Array(0), OPTS), "too_small")
  err(api.axml_decode(new Uint8Array([3, 0]), OPTS), "truncated")
  const truncatedPool = axml.slice(0, 8 + 28 + 13 * 4 + 2) // pool data cut
  const partial = JSON.parse(api.axml_decode(truncatedPool, OPTS))
  assert.equal(partial.schema_version, 1)
  const corrupt = axml.slice()
  for (let i = 0; i < 13; i++) new DataView(corrupt.buffer).setUint32(8 + 28 + i * 4, 0xfffffff0, true)
  const c = ok(api.axml_decode(corrupt, OPTS))
  assert.ok(c.warnings.includes("string_offset_out_of_range"))

  // cap + determinism
  const capped = ok(api.axml_decode(axml, JSON.stringify({ maxXmlBytes: 120 })))
  assert.equal(capped.xml_truncated, true)
  assert.equal(api.axml_decode(axml, OPTS), api.axml_decode(axml, OPTS))
}

// dex_inspect
{
  const r = ok(api.dex_inspect(dex, OPTS))
  assert.equal(r.kind, "dex")
  assert.equal(r.header.version, "035")
  assert.equal(r.header.string_ids, 18)
  assert.equal(r.header.class_defs, 2)
  assert.equal(r.counts.methods, 4)
  assert.equal(r.classes[0].name, "Lcom/example/app/MainActivity;")
  assert.equal(r.classes[0].superclass, "Landroid/app/Activity;")
  assert.equal(r.classes[0].source_file, "MainActivity.java")
  assert.equal(r.classes[0].methods, 2)
  assert.equal(r.classes[1].native_methods, 1)
  assert.equal(r.stats.native_methods, 1)
  assert.equal(r.protos[1].params[0], "Landroid/os/Bundle;")
  assert.equal(r.strings.length, 18)
  const kinds = r.findings.map((f) => f.kind)
  for (const k of ["reflection", "crypto", "su_binary", "dynamic_loading", "exec", "native"]) {
    assert.ok(kinds.includes(k), `missing ${k}`)
  }
  assert.ok(r.map.length >= 10)

  // malformed
  err(api.dex_inspect(new Uint8Array(1), OPTS), "too_small")
  err(api.dex_inspect(str("not a dex file"), OPTS), "bad_magic")
  err(api.dex_inspect(str("dex\n035\0"), OPTS), "truncated_header")
  const badTable = dex.slice()
  new DataView(badTable.buffer).setUint32(60, 0x00ffff00, true)
  err(api.dex_inspect(badTable, OPTS), "table_out_of_bounds")
  const badEndian = dex.slice()
  new DataView(badEndian.buffer).setUint32(40, 0x78563412, true)
  err(api.dex_inspect(badEndian, OPTS), "unsupported_endian")

  // options: multidex index on APK input, limits, determinism
  const viaApk = ok(api.dex_inspect(apk, OPTS))
  assert.equal(viaApk.counts.classes, 2)
  const viaApk2 = ok(api.dex_inspect(apk, JSON.stringify({ dexIndex: 2 })))
  assert.equal(viaApk2.counts.classes, 2)
  err(api.dex_inspect(apk, JSON.stringify({ dexIndex: 7 })), "dex_not_found")
  const limited = ok(api.dex_inspect(dex, JSON.stringify({ limit: 5 })))
  assert.equal(limited.strings.length, 5)
  assert.equal(limited.truncated, true)
  assert.equal(api.dex_inspect(dex, OPTS), api.dex_inspect(dex, OPTS))
}

// apk_inspect
{
  const r = ok(api.apk_inspect(apk, OPTS))
  assert.equal(r.kind, "apk")
  assert.equal(r.zip.entry_count, 6)
  const names = r.zip.entries.map((e) => e.name)
  for (const n of ["AndroidManifest.xml", "classes.dex", "classes2.dex", "resources.arsc", "META-INF/CERT.SF", "META-INF/CERT.RSA"]) {
    assert.ok(names.includes(n), n)
  }
  assert.equal(r.zip.entries.find((e) => e.name === "AndroidManifest.xml").method_name, "deflated")
  assert.equal(r.manifest.present, true)
  assert.equal(r.manifest.decoded, true)
  assert.ok(r.manifest.xml.includes('package="com.example.app"'), r.manifest.xml)
  assert.equal(r.dex_files.length, 2)
  assert.equal(r.dex_files[0].name, "classes.dex")
  assert.equal(r.dex_files[0].dex_version, "035")
  assert.equal(r.dex_files[0].sha256.length, 64)
  assert.equal(r.resources_arsc.packages[0].name, "com.example.app")
  assert.equal(r.signing.v1_signed, true)
  assert.equal(r.signing.v2_block, false)
  assert.ok(r.signing.v1_entries.includes("META-INF/CERT.RSA"))

  const s = ok(api.apk_inspect(apkSigned, OPTS))
  assert.equal(s.signing.v2_block, true)
  assert.equal(s.signing.schemes[0].id, "0x7109871a")
  assert.equal(s.signing.schemes[0].name, "v2")

  const details = ok(api.apk_inspect(apk, JSON.stringify({ dexDetails: true })))
  assert.equal(details.dex_files[0].dex.counts.classes, 2)
  assert.ok(details.dex_files[0].dex.findings.map((f) => f.kind).includes("crypto"))

  // malformed
  err(api.apk_inspect(str("not a zip"), OPTS), "bad_magic")
  err(api.apk_inspect(str("PK\x03\x04"), OPTS), "missing_eocd")
  const noManifest = buildZip([{ name: "classes.dex", data: dex, method: 0 }])
  const nm = ok(api.apk_inspect(noManifest, OPTS))
  assert.equal(nm.manifest.present, false)

  assert.equal(api.apk_inspect(apk, OPTS), api.apk_inspect(apk, OPTS))
}

// shared limits
{
  const huge = new Uint8Array(32 * 1024 * 1024 + 1)
  err(api.axml_decode(huge, OPTS), "input_too_large")
  err(api.dex_inspect(huge, OPTS), "input_too_large")
  err(api.apk_inspect(huge, OPTS), "input_too_large")
  const bigOpts = JSON.stringify({ pad: "x".repeat(4096) })
  err(api.axml_decode(axml, bigOpts), "options_too_large")
  err(api.dex_inspect(dex, bigOpts), "options_too_large")
  err(api.apk_inspect(apk, bigOpts), "options_too_large")
  err(api.axml_decode(axml, "{oops"), "options_invalid")
  err(api.dex_inspect(dex, "[1]"), "options_invalid")
}

console.log("apk-dex WASM verified")
