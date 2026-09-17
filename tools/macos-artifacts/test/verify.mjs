import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

// Real-module verification: every fixture is fabricated here (no files on
// disk) and executed against the built wasm-bindgen package.
const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_macos_artifacts_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_macos_artifacts_wasm_bg.wasm")) })

const ok = (json) => {
  const value = JSON.parse(json)
  assert.equal(value.schema_version, 1, json)
  assert.equal(value.error, undefined, json)
  return value
}
const err = (json, code) => {
  const value = JSON.parse(json)
  assert.equal(value.schema_version, 1, json)
  assert.equal(value.error, code, json)
  return value
}

// ---------- byte helpers ----------
const u16le = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff])
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b }
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const u64be = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b }
const be128 = (v) => { const b = Buffer.alloc(16); b.writeBigUInt64BE(v >> 64n); b.writeBigUInt64BE(v & 0xffffffffffffffffn, 8); return b }
const pad8 = (buf) => Buffer.concat([buf, Buffer.alloc((8 - (buf.length % 8)) % 8)])

// ---------- plist fixtures ----------
const xmlPlist = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Fixture</string>
<key>Count</key><integer>42</integer>
<key>Payload</key><data>3q2+7w==</data>
<key>Items</key><array><string>a</string><string>b</string></array>
</dict></plist>`)

// Hand-assembled bplist00: one dict {"Name": "Fixture"}.
const bplist = (() => {
  const objects = Buffer.concat([
    Buffer.from([0xd1, 0x01, 0x02]), // dict, 1 pair: key ref 1, value ref 2
    Buffer.from([0x54, ...Buffer.from("Name", "ascii")]), // short ASCII string
    Buffer.from([0x57, ...Buffer.from("Fixture", "ascii")]),
  ])
  const offsets = Buffer.from([8, 11, 16])
  const trailer = Buffer.concat([
    Buffer.alloc(6),
    Buffer.from([1, 1]), // offset size, ref size
    u64be(3), // object count
    u64be(0), // root object index
    u64be(8 + objects.length), // offset table position
  ])
  return new Uint8Array(Buffer.concat([Buffer.from("bplist00"), objects, offsets, trailer]))
})()

// ---------- fsevents fixture ----------
const fsevents = (() => {
  const record = (path, eventId, flags, nodeId, v3) =>
    Buffer.concat([
      Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0])]),
      u64le(eventId),
      u32le(flags),
      nodeId === null ? Buffer.alloc(0) : u64le(nodeId),
      v3 ? u32le(0xa5a5a5a5) : Buffer.alloc(0),
    ])
  const page = (magic, records) =>
    Buffer.concat([Buffer.from(magic), u32le(0), u32le(12 + records.length), records])
  const stream = Buffer.concat([
    page("2SLD", record("/Users/test/file.txt", 0x1122, 0x1 | 0x00800000, 99, false)),
    page("2SLD", record("/Users/test/gone", 0x1123, 0x2 | 0x01000000, 100, false)),
    page("3SLD", record("/tmp/x", 0x99, 0x8 | 0x10, 7, true)),
  ])
  return new Uint8Array(gzipSync(stream))
})()

// ---------- .DS_Store fixture ----------
const dsStore = (() => {
  const file = Buffer.alloc(2116 + 256)
  u32be(1).copy(file, 0)
  file.write("Bud1", 4)
  u32be(32).copy(file, 8)
  u32be(2048).copy(file, 12)
  u32be(32).copy(file, 16)

  const root = Buffer.alloc(2048)
  u32be(2).copy(root, 0)
  u32be(0).copy(root, 4)
  u32be((2084 - 4) | 5).copy(root, 8) // block 0: DSDB, 32 bytes
  u32be((2116 - 4) | 8).copy(root, 12) // block 1: leaf, 256 bytes
  u32be(1).copy(root, 8 + 1024) // one TOC entry
  root.writeUInt8(4, 8 + 1028)
  root.write("DSDB", 8 + 1029)
  u32be(0).copy(root, 8 + 1033) // -> block 0
  file.set(root, 36)

  const superblock = Buffer.concat([1, 1, 3, 1, 4096].map(u32be))
  file.set(superblock, 2084)

  const utf16be = (s) => Buffer.concat([...s].map((c) => u32be(c.charCodeAt(0)).subarray(2)))
  const entry = (name, code, type, value) =>
    Buffer.concat([u32be(name.length), utf16be(name), Buffer.from(code), Buffer.from(type), value])
  const leaf = Buffer.concat([
    u32be(0),
    u32be(3),
    entry("Icon", "Iloc", "blob", Buffer.concat([u32be(16), u32be(10), u32be(20), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0])])),
    entry("Notes", "vSrn", "long", u32be(7)),
    entry("Doc", "dscl", "ustr", Buffer.concat([u32be(5), utf16be("hello")])),
  ])
  const padded = Buffer.alloc(256)
  leaf.copy(padded)
  file.set(padded, 2116)
  return new Uint8Array(file)
})()

// ---------- tracev3 fixture ----------
const preamble = (tag, subTag, data) => pad8(Buffer.concat([u32le(tag), u32le(subTag), u64le(data.length), data]))
const tracev3 = (() => {
  const header = (() => {
    const build = Buffer.alloc(16); build.write("24A335")
    const model = Buffer.alloc(32); model.write("MacBookPro18,3")
    const tz = Buffer.alloc(48); tz.write("/var/db/timezone/zoneinfo/UTC")
    return preamble(0x1000, 0x11, Buffer.concat([
      u32le(1), u32le(1), u64le(1000), u64le(0), u32le(0), u32le(0), u32le(0), u32le(0),
      u32le(0x6100), u32le(16), u64le(999),
      u32le(0x6101), u32le(16), u32le(0), u32le(0),
      build, model,
      u32le(0x6102), u32le(24), be128(0x00112233445566778899aabbccddeeFFn), u32le(77), u32le(0),
      u32le(0x6103), u32le(48), tz,
    ]))
  })()
  const catalog = (() => {
    const strings = Buffer.from("com.turen.test\0default\0")
    const procEntry = Buffer.concat([
      u16le(0), u16le(0), u16le(0), u16le(0), u64le(1), u32le(1),
      u32le(501), u32le(20), u32le(0), u32le(1), u32le(0),
      u32le(16), u32le(0), u16le(0), Buffer.alloc(6),
      u32le(1), u32le(0),
      u16le(7), u16le(0), u16le(15), Buffer.alloc(2),
    ])
    assert.equal(procEntry.length, 72)
    const subchunk = Buffer.concat([
      u64le(0), u64le(70), u32le(70), u32le(0x100), u32le(1), u16le(0), u32le(0), Buffer.alloc(6),
    ])
    assert.equal(subchunk.length, 40)
    const sso = 16
    const pieo = sso + strings.length
    const osc = pieo + procEntry.length
    return preamble(0x600b, 0x11, Buffer.concat([
      u16le(sso), u16le(pieo), u16le(1), u16le(osc), u16le(1), Buffer.alloc(6), u64le(1000),
      be128(0x00112233445566778899aabbccddeeFFn), strings, procEntry, subchunk,
    ]))
  })()
  const chunkset = (() => {
    const entry = Buffer.concat([
      Buffer.from([0x4, 0x1]), u16le(0x202), u32le(0x100), u64le(0x1234), u32le(5), u16le(0), u16le(6),
      u32le(0xdeadbeef), u16le(7),
    ])
    assert.equal(entry.length, 30)
    const firehose = preamble(0x6001, 0x11, Buffer.concat([
      u64le(1), u32le(1), Buffer.from([0, 0, 0, 0]), u16le(16 + entry.length), u16le(0x1000),
      Buffer.alloc(4), u64le(0), entry,
    ]))
    return preamble(0x600d, 0x11, Buffer.concat([
      u32le(758412898), u32le(firehose.length), firehose, u32le(0x24347662),
    ]))
  })()
  return new Uint8Array(Buffer.concat([header, catalog, chunkset]))
})()

// ---------- plist ----------
{
  const out = ok(api.plist_parse(bplist, "{}"))
  assert.equal(out.format, "plist")
  assert.equal(out.result.encoding, "binary")
  assert.equal(out.result.root.Name, "Fixture")
  assert.equal(out.result.node_counts.dictionaries, 1)

  const xml = ok(api.plist_parse(xmlPlist, "{}"))
  assert.equal(xml.result.encoding, "xml")
  assert.equal(xml.result.root.Name, "Fixture")
  assert.equal(xml.result.root.Count, 42)
  assert.equal(xml.result.root.Payload.$type, "data")
  assert.equal(xml.result.root.Payload.preview, "deadbeef")

  err(api.plist_parse(new TextEncoder().encode("not a plist at all"), "{}"), "invalid_plist")
  err(api.plist_parse(new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xff, 0xff]), "{}"), "invalid_plist")
}

// ---------- fsevents ----------
{
  const out = ok(api.fsevents_parse(fsevents, "{}"))
  assert.equal(out.format, "fsevents")
  assert.equal(out.result.page_count, 3)
  assert.equal(out.result.record_count, 3)
  assert.equal(out.result.records[0].event_id, 0x1122)
  assert.equal(out.result.records[0].path, "/Users/test/file.txt")
  assert.ok(out.result.records[0].flags.names.includes("Created"))
  assert.ok(out.result.records[0].flags.names.includes("IsFile"))
  assert.ok(out.result.records[1].flags.names.includes("Removed"))

  err(api.fsevents_parse(new TextEncoder().encode("not gzip or pages"), "{}"), "not_fsevents")
  err(api.fsevents_parse(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]), "{}"), "invalid_gzip")
}

// ---------- ds_store ----------
{
  const out = ok(api.ds_store_parse(dsStore, "{}"))
  assert.equal(out.format, "ds_store")
  assert.equal(out.result.superblock.page_size, 4096)
  assert.equal(out.result.record_count, 3)
  assert.equal(out.result.records[0].filename, "Icon")
  assert.equal(out.result.records[0].value.x, 10)
  assert.equal(out.result.records[2].value, "hello")

  err(api.ds_store_parse(new TextEncoder().encode("short"), "{}"), "invalid_ds_store")
}

// ---------- unified log ----------
{
  const out = ok(api.unified_log_parse(tracev3, "{}"))
  assert.equal(out.format, "unified_log")
  assert.equal(out.result.header.boot_uuid, "00112233445566778899AABBCCDDEEFF")
  assert.equal(out.result.header.logd_pid, 77)
  assert.equal(out.result.entry_count, 1)
  const entry = out.result.entries[0]
  assert.equal(entry.pid, 501)
  assert.equal(entry.subsystem, "com.turen.test")
  assert.equal(entry.category, "default")
  assert.ok(entry.message.includes("Failed to get string message from UUIDText file"))
  assert.equal(out.result.missing_message_entries, 1)
  assert.ok(out.warnings.some((w) => w.includes("unresolved format strings")))

  err(api.unified_log_parse(new TextEncoder().encode("garbage"), "{}"), "invalid_tracev3")
}

// ---------- dispatch + bounds + determinism ----------
{
  assert.equal(ok(api.analyze(bplist, "{}")).format, "plist")
  assert.equal(ok(api.analyze(fsevents, "{}")).format, "fsevents")
  assert.equal(ok(api.analyze(dsStore, "{}")).format, "ds_store")
  assert.equal(ok(api.analyze(tracev3, "{}")).format, "unified_log")
  err(api.analyze(new Uint8Array([0, 1, 2, 3]), "{}"), "unknown_artifact")

  err(api.plist_parse(new Uint8Array(0), "{}"), "empty_input")
  err(api.plist_parse(new Uint8Array(32 * 1024 * 1024 + 1), "{}"), "input_too_large")
  err(api.plist_parse(bplist, " ".repeat(4097)), "options_too_large")
  err(api.plist_parse(bplist, "[1]"), "invalid_options")
  err(api.plist_parse(bplist, "{"), "invalid_options")

  for (const fixture of [bplist, xmlPlist, fsevents, dsStore, tracev3]) {
    assert.equal(api.analyze(fixture, "{}"), api.analyze(fixture, "{}"))
  }
}

console.log("macos-artifacts WASM compatibility verified")
