// Verifies the real built git-inspect WASM artifact (pkg or packaged dist
// directory) — no mocks. All fixtures are fabricated here in JS: node:zlib
// provides deflate for loose objects and pack entry streams, node:crypto
// provides SHA-1 for pack/index trailers.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateSync } from "node:zlib"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_git_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_git_inspect_wasm_bg.wasm")) })

const sha1 = (bytes) => createHash("sha1").update(bytes).digest()
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex")
const u32be = (n) => Buffer.from([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])

// ---- fixture builders -----------------------------------------------------

const loose = (kind, content) => {
  const body = Buffer.concat([Buffer.from(`${kind} ${content.length}\0`), Buffer.from(content)])
  return deflateSync(body)
}

const BLOB = Buffer.from("test content\n")
// Canonical git object id for `blob 13\0test content\n` (Pro Git 10.2).
const BLOB_SHA1 = "d670460b4b4aece5915caf5c68d12f560a9fe3e4"

const COMMIT = Buffer.from(
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
    "parent 1111111111111111111111111111111111111111\n" +
    "parent 9999999999999999999999999999999999999999\n" +
    "author A U Thor <author@example.com> 1700000000 +0000\n" +
    "committer C O Mitter <commit@example.com> 1700000100 -0800\n" +
    "\nInitial commit\n",
)
const TAG = Buffer.from(
  "object 2222222222222222222222222222222222222222\ntype commit\ntag v1.0\n" +
    "tagger T Agger <tag@example.com> 1700000200 +0000\n\nrelease notes\n",
)
const treeBody = (() => {
  const parts = []
  const push = (mode, name, sha) => {
    parts.push(Buffer.from(`${mode} ${name}\0`), sha)
  }
  push("100644", "file.txt", Buffer.alloc(20, 0xaa))
  push("40000", "subdir", Buffer.alloc(20, 0xbb))
  push("120000", "link", Buffer.alloc(20, 0xcc))
  return Buffer.concat(parts)
})()

const objectId = (kind, content) =>
  sha1(Buffer.concat([Buffer.from(`${kind} ${content.length}\0`), Buffer.from(content)]))

const entryHeader = (kind, size) => {
  const out = []
  let first = ((kind & 7) << 4) | (Number(size) & 0x0f)
  let rest = BigInt(size) >> 4n
  if (rest > 0n) first |= 0x80
  out.push(first)
  while (rest > 0n) {
    let b = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest > 0n) b |= 0x80
    out.push(b)
  }
  return Buffer.from(out)
}

// git's offset varint (with +1 carry), most significant group first.
const offsetVarint = (value) => {
  const out = [Number(value & 0x7fn)]
  let v = value >> 7n
  while (v > 0n) {
    v -= 1n
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  return Buffer.from(out.reverse())
}

// delta-payload varint: little-endian 7-bit groups, MSB continuation.
const deltaVarint = (value) => {
  const out = []
  let v = BigInt(value)
  for (;;) {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
    if (v === 0n) return Buffer.from(out)
  }
}

const copyOp = (offset, size) => {
  let cmd = 0x80
  const tail = []
  const ob = Buffer.alloc(4)
  ob.writeUInt32LE(offset)
  const sb = Buffer.alloc(4)
  sb.writeUInt32LE(size)
  for (let i = 0; i < 4; i++) if (ob[i] !== 0) { cmd |= 1 << i; tail.push(ob[i]) }
  for (let i = 0; i < 3; i++) if (sb[i] !== 0) { cmd |= 0x10 << i; tail.push(sb[i]) }
  return Buffer.from([cmd, ...tail])
}
const insertOp = (data) => Buffer.from([data.length, ...data])
const delta = (baseLen, resultLen, ops) =>
  Buffer.concat([deltaVarint(baseLen), deltaVarint(resultLen), Buffer.concat(ops)])

// entries: {kind, data} | {ofsDelta: baseIndex, delta} | {refDelta: sha1buf, delta}
const pack = (entries, { version = 2, fixTrailer = true } = {}) => {
  const parts = [Buffer.from("PACK"), u32be(version), u32be(entries.length)]
  const offsets = []
  for (const e of entries) {
    offsets.push(Buffer.concat(parts).length)
    if (e.data !== undefined) {
      parts.push(entryHeader(e.kind, e.data.length), deflateSync(e.data))
    } else if (e.ofsDelta !== undefined) {
      const distance = Buffer.concat(parts).length - offsets[e.ofsDelta]
      parts.push(entryHeader(6, e.delta.length), offsetVarint(BigInt(distance)), deflateSync(e.delta))
    } else {
      parts.push(entryHeader(7, e.delta.length), e.refDelta, deflateSync(e.delta))
    }
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, fixTrailer ? sha1(body) : Buffer.alloc(20, 0x5a)])
}

const base1 = Buffer.from("hello world, this is base content")
const base2 = Buffer.from("second base object body")
const d1 = delta(base1.length, 12, [copyOp(0, 5), insertOp(Buffer.from(" WORLD!"))])
const d2 = delta(base2.length, 7, [copyOp(0, 6), insertOp(Buffer.from("!"))])
const PACK = pack([
  { kind: 3, data: base1 },          // 0: blob base1
  { ofsDelta: 0, delta: d1 },        // 1: "hello WORLD!"
  { kind: 1, data: COMMIT },         // 2: commit
  { kind: 3, data: base2 },          // 3: blob base2
  { refDelta: objectId("blob", base2), delta: d2 }, // 4: "second!"
])

const deepPack = (() => {
  const d = delta(4, 4, [copyOp(0, 4)])
  const entries = [{ kind: 3, data: Buffer.from("base") }]
  for (let i = 0; i < 70; i++) entries.push({ ofsDelta: i, delta: d })
  return pack(entries)
})()

const packIndexV2 = (shas) => {
  const sorted = [...shas].sort(Buffer.compare)
  const fanout = []
  let cursor = 0
  for (let b = 0; b < 256; b++) {
    while (cursor < sorted.length && sorted[cursor][0] <= b) cursor++
    fanout.push(u32be(cursor))
  }
  const head = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63]), u32be(2), ...fanout])
  const tables = Buffer.concat([
    ...sorted,
    ...sorted.map(() => u32be(0)),
    ...sorted.map((_, i) => u32be(12 + i)),
    sha1(Buffer.from("pack")),
  ])
  const body = Buffer.concat([head, tables])
  return Buffer.concat([body, sha1(body)])
}

const packIndexV1 = (shas) => {
  const sorted = [...shas].sort(Buffer.compare)
  const fanout = []
  let cursor = 0
  for (let b = 0; b < 256; b++) {
    while (cursor < sorted.length && sorted[cursor][0] <= b) cursor++
    fanout.push(u32be(cursor))
  }
  return Buffer.concat([...fanout, ...sorted.map((s, i) => Buffer.concat([u32be(i), s]))])
}

const dircEntry = (path, sha, mode, { stage = 0, size = 0 } = {}) => ({ path, sha, mode, stage, size })
const dircV23 = (version, entries, extensions = []) => {
  const parts = [Buffer.from("DIRC"), u32be(version), u32be(entries.length)]
  for (const e of entries) {
    const fixed = [1700000000, 123456789, 1700000100, 987654321, 0x8001, 0xdead, e.mode, 501, 20, e.size]
    for (const v of fixed) parts.push(u32be(v))
    parts.push(e.sha)
    const flags = ((e.stage & 3) << 12) | Math.min(Buffer.byteLength(e.path), 0xfff)
    parts.push(Buffer.from([flags >> 8, flags & 0xff]))
    const name = Buffer.from(e.path)
    parts.push(name)
    const pad = 8 - ((62 + name.length) % 8)
    parts.push(Buffer.alloc(pad))
  }
  for (const [name, payload] of extensions) {
    parts.push(Buffer.from(name), u32be(payload.length), payload)
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, sha1(body)])
}

const dircV4 = (entries) => {
  const parts = [Buffer.from("DIRC"), u32be(4), u32be(entries.length)]
  let prev = Buffer.alloc(0)
  for (const e of entries) {
    const fixed = [1700000000, 123456789, 1700000100, 987654321, 0x8001, 0xdead, e.mode, 501, 20, e.size]
    for (const v of fixed) parts.push(u32be(v))
    parts.push(e.sha)
    const name = Buffer.from(e.path)
    parts.push(Buffer.from([name.length >> 8, name.length & 0xff]))
    let common = 0
    while (common < prev.length && common < name.length && prev[common] === name[common]) common++
    parts.push(offsetVarint(BigInt(prev.length - common)), name.subarray(common), Buffer.from([0]))
    prev = name
  }
  const body = Buffer.concat(parts)
  return Buffer.concat([body, sha1(body)])
}

const DIRC = dircV23(
  2,
  [
    dircEntry("src/main.rs", Buffer.alloc(20, 0x11), 0o100644, { size: 1234 }),
    dircEntry("README.md", Buffer.alloc(20, 0x22), 0o100644, { stage: 1, size: 56 }),
    dircEntry("link", Buffer.alloc(20, 0x33), 0o120000),
    dircEntry("sub", Buffer.alloc(20, 0x44), 0o160000),
  ],
  [
    ["TREE", Buffer.from("\x00tree-data")],
    ["REUC", Buffer.from([1, 2, 3])],
  ],
)
const DIRC4 = dircV4([
  dircEntry("src/a.txt", Buffer.alloc(20, 0x11), 0o100644),
  dircEntry("src/b.txt", Buffer.alloc(20, 0x22), 0o100644),
  dircEntry("src/dir/c.txt", Buffer.alloc(20, 0x33), 0o100644),
  dircEntry("top.txt", Buffer.alloc(20, 0x44), 0o100644),
])

const BUNDLE = Buffer.concat([
  Buffer.from("# v2 git bundle\n"),
  Buffer.from("-0123456789012345678901234567890123456789 base commit\n"),
  Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\n\n"),
  pack([{ kind: 3, data: Buffer.from("hello") }]),
])

const ok = (text) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, undefined, text)
  return value
}
const err = (text, code) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, code, text)
}
const OPTIONS = "{}"

// ---- git_identify -----------------------------------------------------------

for (const [kind, content] of [
  ["blob", BLOB],
  ["commit", COMMIT],
  ["tag", TAG],
  ["tree", treeBody],
]) {
  const id = ok(api.git_identify(loose(kind, content)))
  assert.equal(id.kind, "loose-object")
  assert.equal(id.objectType, kind)
  assert.equal(id.decompressionComplete, true)
}
{
  const id = ok(api.git_identify(PACK))
  assert.equal(id.kind, "pack")
  assert.equal(id.version, 2)
  assert.equal(id.declaredObjects, 5)
  assert.equal(id.trailerSha1Valid, true)
}
{
  const idx = packIndexV2([Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22), Buffer.alloc(20, 0x33)])
  const id = ok(api.git_identify(idx))
  assert.equal(id.kind, "pack-index")
  assert.equal(id.version, 2)
  assert.equal(id.objectCount, 3)
  assert.equal(id.sizeMatches, true)
  assert.equal(id.indexSha1Valid, true)
}
{
  const idx = packIndexV1([Buffer.alloc(20, 0x11), Buffer.alloc(20, 0x22)])
  const id = ok(api.git_identify(idx))
  assert.equal(id.kind, "pack-index")
  assert.equal(id.version, 1)
  assert.equal(id.objectCount, 2)
}
{
  const id = ok(api.git_identify(DIRC))
  assert.equal(id.kind, "index")
  assert.equal(id.version, 2)
  assert.equal(id.declaredEntries, 4)
  assert.equal(id.trailerSha1Valid, true)
}
{
  const id = ok(api.git_identify(BUNDLE))
  assert.equal(id.kind, "bundle")
  assert.equal(id.version, 2)
  assert.equal(id.prerequisites, 1)
  assert.equal(id.refs, 1)
  assert.equal(id.packFollows, true)
}
assert.equal(ok(api.git_identify(new Uint8Array([1, 2, 3, 4, 5]))).kind, "unknown")
assert.equal(ok(api.git_identify(deflateSync(Buffer.from("random data")))).kind, "unknown")
err(api.git_identify(new Uint8Array(0)), "empty_input")
err(api.git_identify(new Uint8Array(33 * 1024 * 1024)), "input_too_large")

// ---- git_object_decode --------------------------------------------------------

{
  const v = ok(api.git_object_decode(loose("blob", BLOB), OPTIONS))
  assert.equal(v.type, "blob")
  assert.equal(v.sha1, BLOB_SHA1)
  assert.equal(v.declaredSize, 13)
  assert.equal(v.sizeMatchesDeclared, true)
  assert.equal(v.content.utf8, true)
  assert.equal(v.content.sha256, sha256hex(BLOB))
}
{
  const v = ok(api.git_object_decode(loose("commit", COMMIT), OPTIONS))
  assert.equal(v.type, "commit")
  assert.equal(v.content.tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904")
  assert.deepEqual(v.content.parents, [
    "1111111111111111111111111111111111111111",
    "9999999999999999999999999999999999999999",
  ])
  assert.equal(v.content.author.name, "A U Thor")
  assert.equal(v.content.author.email, "author@example.com")
  assert.equal(v.content.author.timestamp, 1700000000)
  assert.equal(v.content.committer.timezone, "-0800")
  assert.equal(v.content.message.text, "Initial commit\n")
}
{
  const v = ok(api.git_object_decode(loose("tag", TAG), OPTIONS))
  assert.equal(v.type, "tag")
  assert.equal(v.content.object, "2222222222222222222222222222222222222222")
  assert.equal(v.content.tag, "v1.0")
  assert.equal(v.content.tagger.email, "tag@example.com")
}
{
  const v = ok(api.git_object_decode(loose("tree", treeBody), OPTIONS))
  const entries = v.content.entries
  assert.equal(entries.length, 3)
  assert.equal(entries[0].mode, "0o100644")
  assert.equal(entries[0].name, "file.txt")
  assert.equal(entries[0].sha1, "aa".repeat(20))
  assert.equal(entries[1].kind, "tree")
  assert.equal(entries[2].kind, "symlink")
}
{
  // declared size disagrees with content
  const v = ok(api.git_object_decode(deflateSync(Buffer.from("blob 99\0hi")), OPTIONS))
  assert.equal(v.sizeMatchesDeclared, false)
  // trailing garbage after the zlib stream
  const trailed = Buffer.concat([loose("blob", BLOB), Buffer.from("GARBAGE")])
  const v2 = ok(api.git_object_decode(trailed, OPTIONS))
  assert.equal(v2.trailingBytes, 7)
  // blob preview bound
  const big = loose("blob", Buffer.alloc(200 * 1024, 0x41))
  const v3 = ok(api.git_object_decode(big, "{\"maxPreviewBytes\":65536}"))
  assert.equal(v3.content.previewBytes, 65536)
  assert.equal(v3.truncated, true)
}
err(api.git_object_decode(Buffer.from("PACK...."), OPTIONS), "not_loose_object")
{
  const short = loose("blob", BLOB).subarray(0, 12)
  err(api.git_object_decode(short, OPTIONS), "truncated_zlib")
}
err(api.git_object_decode(deflateSync(Buffer.from("\0\0\0")), OPTIONS), "not_loose_object")

// ---- git_pack_inspect ---------------------------------------------------------

{
  const v = ok(api.git_pack_inspect(PACK, OPTIONS))
  assert.equal(v.kind, "pack")
  assert.equal(v.version, 2)
  assert.equal(v.declaredObjects, 5)
  assert.equal(v.parsedObjects, 5)
  assert.equal(v.scanComplete, true)
  assert.equal(v.checksum.valid, true)
  assert.equal(v.entries.length, 5)
  assert.equal(v.entries[0].type, "blob")
  assert.equal(v.entries[1].type, "ofs_delta")
  assert.equal(v.entries[1].baseOffset, v.entries[0].offset)
  assert.equal(v.entries[4].type, "ref_delta")
  assert.equal(v.entries[1].depth, 1)
  assert.equal(v.deltas.ofsDeltaCount, 1)
  assert.equal(v.deltas.refDeltaCount, 1)
  assert.equal(v.deltas.maxChainDepth, 1)
}
{
  const bad = pack([{ kind: 3, data: BLOB }], { fixTrailer: false })
  const v = ok(api.git_pack_inspect(bad, OPTIONS))
  assert.equal(v.checksum.valid, false)
}
{
  const v = ok(api.git_pack_inspect(deepPack, OPTIONS))
  assert.equal(v.deltas.maxChainDepth, 70)
  const v2 = ok(api.git_pack_inspect(PACK, "{\"maxItems\":2}"))
  assert.equal(v2.entries.length, 2)
  assert.equal(v2.truncated, true)
}
err(api.git_pack_inspect(Buffer.from("NOPE........"), OPTIONS), "not_pack")
err(
  api.git_pack_inspect(pack([], { version: 4 }), OPTIONS),
  "unsupported_pack_version",
)

// ---- git_pack_entry -----------------------------------------------------------

{
  const listed = ok(api.git_pack_inspect(PACK, OPTIONS))
  const byIndex = ok(api.git_pack_entry(PACK, "{\"index\":0}"))
  assert.equal(byIndex.type, "blob")
  assert.equal(byIndex.size, base1.length)
  assert.equal(byIndex.chainDepth, 0)
  assert.equal(byIndex.sha1, objectId("blob", base1).toString("hex"))
  assert.equal(Buffer.from(byIndex.previewBase64, "base64").toString(), base1.toString())
  const byOffset = ok(api.git_pack_entry(PACK, `{"offset":${listed.entries[0].offset}}`))
  assert.equal(byOffset.sha1, byIndex.sha1)

  const d = ok(api.git_pack_entry(PACK, "{\"index\":1}"))
  assert.equal(d.type, "blob")
  assert.equal(d.chainDepth, 1)
  assert.equal(Buffer.from(d.previewBase64, "base64").toString(), "hello WORLD!")

  const r = ok(api.git_pack_entry(PACK, "{\"index\":4}"))
  assert.equal(r.type, "blob")
  assert.equal(r.chainDepth, 1)
  assert.equal(Buffer.from(r.previewBase64, "base64").toString(), "second!")
  assert.equal(r.sha1, objectId("blob", Buffer.from("second!")).toString("hex"))

  const commit = ok(api.git_pack_entry(PACK, "{\"index\":2}"))
  assert.equal(commit.type, "commit")
}
{
  // raw byte extraction — the "one bounded byte vector" op
  const raw = api.git_pack_entry_raw(PACK, "{\"index\":1}")
  assert.equal(Buffer.from(raw).toString(), "hello WORLD!")
  assert.throws(() => api.git_pack_entry_raw(PACK, "{\"index\":99}"), /entry_not_found/)
  assert.throws(() => api.git_pack_entry_raw(PACK, "{}"), /missing_selector/)
  assert.throws(() => api.git_pack_entry_raw(Buffer.from("nope"), "{\"index\":0}"), /not_pack/)
}
{
  err(api.git_pack_entry(PACK, "{}"), "missing_selector")
  err(api.git_pack_entry(PACK, "{\"index\":0,\"offset\":12}"), "conflicting_selectors")
  err(api.git_pack_entry(PACK, "{\"index\":99}"), "entry_not_found")
  err(api.git_pack_entry(deepPack, "{\"index\":70}"), "delta_depth_exceeded")
  // thin pack: ref-delta base absent
  const thin = pack([
    { kind: 3, data: Buffer.from("base") },
    { refDelta: Buffer.alloc(20, 0x42), delta: delta(4, 4, [copyOp(0, 4)]) },
  ])
  err(api.git_pack_entry(thin, "{\"index\":1}"), "base_not_found")
}

// ---- git_index_inspect --------------------------------------------------------

{
  const v = ok(api.git_index_inspect(DIRC, OPTIONS))
  assert.equal(v.kind, "index")
  assert.equal(v.version, 2)
  assert.equal(v.declaredEntries, 4)
  assert.equal(v.parsedEntries, 4)
  assert.equal(v.checksumValid, true)
  assert.equal(v.entries.length, 4)
  assert.equal(v.entries[0].path, "src/main.rs")
  assert.equal(v.entries[0].mode, "0o100644")
  assert.equal(v.entries[0].modeKind, "file")
  assert.equal(v.entries[0].size, 1234)
  assert.equal(v.entries[0].mtime.seconds, 1700000100)
  assert.equal(v.entries[0].uid, 501)
  assert.equal(v.entries[1].stage, 1)
  assert.equal(v.entries[2].modeKind, "symlink")
  assert.equal(v.entries[3].modeKind, "gitlink")
  assert.equal(v.extensions.length, 2)
  assert.equal(v.extensions[0].name, "TREE")
  assert.equal(v.extensions[0].size, 10)
  assert.equal(v.extensions[1].name, "REUC")
}
{
  const v = ok(api.git_index_inspect(DIRC4, OPTIONS))
  assert.equal(v.version, 4)
  assert.deepEqual(v.entries.map((e) => e.path), ["src/a.txt", "src/b.txt", "src/dir/c.txt", "top.txt"])
  assert.equal(v.checksumValid, true)
  const limited = ok(api.git_index_inspect(DIRC, "{\"maxItems\":2}"))
  assert.equal(limited.entries.length, 2)
  assert.equal(limited.parsedEntries, 4)
  assert.equal(limited.truncated, true)
}
err(api.git_index_inspect(Buffer.from("PACK........"), OPTIONS), "not_index")
err(api.git_index_inspect(
  Buffer.concat([Buffer.from("DIRC"), u32be(5), u32be(0), Buffer.alloc(20)]),
  OPTIONS,
), "unsupported_index_version")
{
  const cut = DIRC.subarray(0, 12 + 40) // mid-first-entry
  const v = ok(api.git_index_inspect(cut, OPTIONS))
  assert.equal(v.parsedEntries, 0)
  assert.equal(v.checksumValid, false)
  assert.ok(v.warnings.length > 0)
}

// ---- limits + determinism -----------------------------------------------------

err(api.git_object_decode(loose("blob", BLOB), `{"pad":"${"x".repeat(5000)}"}`), "options_too_large")
err(api.git_object_decode(loose("blob", BLOB), "{oops"), "invalid_options")
err(api.git_pack_inspect(new Uint8Array(33 * 1024 * 1024), OPTIONS), "input_too_large")
err(api.git_index_inspect(new Uint8Array(33 * 1024 * 1024), OPTIONS), "input_too_large")

assert.equal(api.git_pack_inspect(PACK, OPTIONS), api.git_pack_inspect(PACK, OPTIONS))
assert.equal(api.git_index_inspect(DIRC, OPTIONS), api.git_index_inspect(DIRC, OPTIONS))
assert.equal(api.git_object_decode(loose("commit", COMMIT), OPTIONS), api.git_object_decode(loose("commit", COMMIT), OPTIONS))
assert.equal(api.git_identify(PACK), api.git_identify(PACK))

console.log("git-inspect WASM compatibility verified")
