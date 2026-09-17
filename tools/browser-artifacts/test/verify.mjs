import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Real-module verification: every fixture is fabricated here (no files on
// disk) and executed against the built wasm-bindgen package.
const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_browser_artifacts_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_browser_artifacts_wasm_bg.wasm")) })

let checks = 0
const ok = (json) => {
  const value = JSON.parse(json)
  checks += 1
  assert.equal(value.schema_version, 1, json)
  assert.equal(value.error, undefined, json)
  return value
}
const err = (json, code) => {
  const value = JSON.parse(json)
  checks += 1
  assert.equal(value.schema_version, 1, json)
  assert.equal(value.error, code, json)
  return value
}

// ---------------- shared builders ----------------
const u16le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b }
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const f64le = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b }

const varint = (v) => {
  const out = []
  let x = BigInt(v)
  for (;;) {
    let byte = Number(x & 0x7fn)
    x >>= 7n
    if (x !== 0n) byte |= 0x80
    out.push(byte)
    if (x === 0n) return Buffer.from(out)
  }
}

// CRC-32C (Castagnoli), reflected poly 0x82F63B78 — bitwise is fine for
// fixture-sized inputs.
const crc32c = (data) => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1
  }
  return (~crc) >>> 0
}
const maskCrc = (crc) => (((crc >>> 15) | ((crc << 17) >>> 0)) + 0xa282ead8) >>> 0
const recordCrc = (type, data) => maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data])))

// zlib CRC-32 (IEEE) for simple-cache EOF records.
const crc32ieee = (data) => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (~crc) >>> 0
}

// Chromium base::PersistentHash (SuperFastHash).
const superFastHash = (data) => {
  const get16 = (d, i) => d[i] | (d[i + 1] << 8)
  let hash = data.length >>> 0
  let i = 0
  for (; i + 4 <= data.length; i += 4) {
    hash = (hash + get16(data, i)) >>> 0
    const tmp = ((get16(data, i + 2) << 11) ^ hash) >>> 0
    hash = (((hash << 16) >>> 0) ^ tmp) >>> 0
    hash = (hash + (hash >>> 11)) >>> 0
  }
  const rem = data.length - i
  if (rem === 3) {
    hash = (hash + get16(data, i)) >>> 0
    hash ^= (hash << 16) >>> 0
    hash = hash >>> 0
    hash ^= ((data[i + 2] << 24) >> 24 << 18) >>> 0
    hash = (hash + (hash >>> 11)) >>> 0
  } else if (rem === 2) {
    hash = (hash + get16(data, i)) >>> 0
    hash ^= (hash << 11) >>> 0
    hash = hash >>> 0
    hash = (hash + (hash >>> 17)) >>> 0
  } else if (rem === 1) {
    hash = (hash + data[i]) >>> 0
    hash ^= (hash << 10) >>> 0
    hash = hash >>> 0
    hash = (hash + (hash >>> 6)) >>> 0
  }
  hash ^= (hash << 3) >>> 0
  hash = hash >>> 0
  hash = (hash + (hash >>> 5)) >>> 0
  hash ^= (hash << 4) >>> 0
  hash = hash >>> 0
  hash = (hash + (hash >>> 17)) >>> 0
  hash ^= (hash << 25) >>> 0
  hash = hash >>> 0
  hash = (hash + (hash >>> 6)) >>> 0
  return hash >>> 0
}

const sha256 = (data) => createHash("sha256").update(data).digest()

// ---------------- LevelDB log fixtures ----------------
const BLOCK = 32768
const [FULL, FIRST, MIDDLE, LAST] = [1, 2, 3, 4]

const logRecord = (type, data) =>
  Buffer.concat([u32le(recordCrc(type, data)), u16le(data.length), Buffer.from([type]), data])

const writeBatch = (seq, entries) => {
  const parts = [u64le(seq), u32le(entries.length)]
  for (const [tag, key, value] of entries) {
    parts.push(Buffer.from([tag]), varint(key.length), key)
    if (value !== null) parts.push(varint(value.length), value)
  }
  return Buffer.concat(parts)
}

const padBlock = (buf) => Buffer.concat([buf, Buffer.alloc(BLOCK - buf.length)])

const simpleLog = new Uint8Array(padBlock(logRecord(FULL, writeBatch(1000, [
  [1, Buffer.from("_http://a.com\x01key1"), Buffer.from("value1")],
  [1, Buffer.from("key2"), Buffer.from("value2")],
  [0, Buffer.from("oldkey"), null],
]))))

const fragmentedLog = (() => {
  const big = Buffer.alloc(40000, 0x61)
  const batch = writeBatch(7, [[1, Buffer.from("k"), big]])
  const firstLen = BLOCK - 7
  return new Uint8Array(Buffer.concat([
    logRecord(FIRST, batch.subarray(0, firstLen)),
    logRecord(LAST, batch.subarray(firstLen)),
  ]))
})()

const corruptLog = (() => {
  const good = logRecord(FULL, writeBatch(1, [[1, Buffer.from("good"), Buffer.from("one")]]))
  good[0] ^= 0xff // corrupt stored crc
  const next = logRecord(FULL, writeBatch(2, [[1, Buffer.from("next"), Buffer.from("two")]]))
  return new Uint8Array(Buffer.concat([padBlock(good), padBlock(next)]))
})()

const manifestLog = (() => {
  const payload = Buffer.concat([u64le(0xdead), u32le(0), Buffer.from("VersionEdit-ish")])
  return new Uint8Array(padBlock(logRecord(FULL, payload)))
})()

// ---------------- LevelDB table fixtures ----------------
const TABLE_MAGIC = 0xdb4775248b80fb57n

const internalKey = (user, seq, type) =>
  Buffer.concat([Buffer.from(user), u64le((BigInt(seq) << 8n) | BigInt(type))])

const buildBlock = (entries, restartInterval = 4) => {
  const out = []
  const restarts = []
  let lastKey = Buffer.alloc(0)
  entries.forEach(([key, value], i) => {
    let shared = 0
    if (i % restartInterval === 0) {
      restarts.push(out.reduce((n, b) => n + b.length, 0))
    } else {
      while (shared < key.length && shared < lastKey.length && key[shared] === lastKey[shared]) shared++
    }
    out.push(varint(shared), varint(key.length - shared), varint(value.length),
      key.subarray(shared), value)
    lastKey = key
  })
  for (const r of restarts) out.push(u32le(r))
  out.push(u32le(restarts.length))
  return Buffer.concat(out)
}

const blockOnDisk = (contents, compression, corrupt = false) => {
  let crc = maskCrc(crc32c(Buffer.concat([contents, Buffer.from([compression])])))
  if (corrupt) crc ^= 0xffff
  return Buffer.concat([contents, Buffer.from([compression]), u32le(crc)])
}

const snappyLiteral = (data) => {
  const out = [varint(data.length)]
  let rest = data
  while (rest.length) {
    const take = Math.min(rest.length, 1 << 16)
    const len = take - 1
    if (take <= 60) out.push(Buffer.from([len << 2]))
    else if (take <= 256) out.push(Buffer.from([60 << 2, len]))
    else out.push(Buffer.from([61 << 2, len & 0xff, len >> 8]))
    out.push(rest.subarray(0, take))
    rest = rest.subarray(take)
  }
  return Buffer.concat(out)
}

const handleBytes = (offset, size) => Buffer.concat([varint(offset), varint(size)])

const sampleTable = (() => {
  const data1 = buildBlock([
    [internalKey("alpha", 100, 1), Buffer.from("v1")],
    [internalKey("alphabet", 99, 1), Buffer.from("v2")],
    [internalKey("beta", 98, 0), Buffer.alloc(0)],
  ])
  const data2 = buildBlock([[internalKey("gamma", 97, 1), Buffer.from("gval")]], 1)
  const metaindex = buildBlock([[Buffer.from("filter.leveldb.BuiltinBloomFilter2"), handleBytes(0, 0)]], 1)
  const file = []
  const d1Off = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(data1, 0))
  const d2Off = file.reduce((n, b) => n + b.length, 0)
  const snappy = snappyLiteral(data2)
  file.push(blockOnDisk(snappy, 1))
  const metaOff = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(metaindex, 0))
  const index = buildBlock([
    [internalKey("alphabet", 99, 1), handleBytes(d1Off, data1.length)],
    [internalKey("zzz", 1, 1), handleBytes(d2Off, snappy.length)],
  ], 1)
  const idxOff = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(index, 0))
  const footer = Buffer.concat([
    handleBytes(metaOff, metaindex.length),
    handleBytes(idxOff, index.length),
  ])
  const padded = Buffer.concat([footer, Buffer.alloc(40 - footer.length), u64le(TABLE_MAGIC)])
  assert.equal(padded.length, 48)
  file.push(padded)
  return new Uint8Array(Buffer.concat(file))
})()

// ---------------- simple cache fixtures ----------------
const INITIAL_MAGIC = 0xfcfb6d1ba7725c30n
const FINAL_MAGIC = 0xf4fa6f45970d41d8n
const SPARSE_MAGIC = 0xeb97bf016553676bn

const eofRecord = (flags, crc, streamSize) =>
  Buffer.concat([u64le(FINAL_MAGIC), u32le(flags), u32le(crc), u32le(streamSize), u32le(0)])

const cacheHeader = (key) =>
  Buffer.concat([
    u64le(INITIAL_MAGIC), u32le(5), u32le(key.length), u32le(superFastHash(key)), u32le(0), key,
  ])

const responseInfoPickle = (() => {
  const headers = Buffer.from("HTTP/1.1 200 OK\0content-type: text/html\0content-length: 5\0\0")
  const payload = Buffer.concat([
    u32le(0x80000003), u32le(4),
    u64le(13340000000000000n), u64le(13340000001000000n), u64le(13340000000500000n),
    u32le(headers.length), headers,
  ])
  const pad = Buffer.alloc((4 - (payload.length % 4)) % 4)
  return Buffer.concat([u32le(payload.length + pad.length), payload, pad])
})()

const combinedEntry = (key, stream1, stream0, withSha) => {
  const parts = [cacheHeader(key), stream1, eofRecord(1, crc32ieee(stream1), 0), stream0]
  if (withSha) parts.push(sha256(key))
  parts.push(eofRecord(withSha ? 3 : 1, crc32ieee(stream0), stream0.length))
  return new Uint8Array(Buffer.concat(parts))
}

const singleStreamEntry = (key, data) =>
  new Uint8Array(Buffer.concat([cacheHeader(key), data, eofRecord(1, crc32ieee(data), 0)]))

const sparseFile = (() => {
  const range = (offset, data) => Buffer.concat([
    u64le(SPARSE_MAGIC), u64le(offset), u64le(data.length), u32le(crc32ieee(data)), u32le(0), data,
  ])
  return new Uint8Array(Buffer.concat([range(0n, Buffer.from("range-one-bytes!")), range(0x1000n, Buffer.from("r2"))]))
})()

// ---------------- binarycookies fixtures ----------------
const cookieRecord = (domain, name, path, value, flags, expires, created) => {
  const strings = Buffer.concat([domain, name, path, value].map((s) => Buffer.from(s + "\0")))
  const offs = []
  let p = 56
  for (const s of [domain, name, path, value]) {
    offs.push(u32le(p))
    p += s.length + 1
  }
  return Buffer.concat([
    u32le(56 + strings.length), u32le(1), u32le(flags), u32le(0),
    ...offs, u64le(0n), f64le(expires), f64le(created), strings,
  ])
}

const binarycookies = (() => {
  const c1 = cookieRecord(".example.com", "sess", "/", "abc123", 5, 700000000.0, 600000000.0)
  const c2 = cookieRecord(".other.net", "pref", "/p", "x", 0, 800000000.0, 500000000.0)
  const off1 = 8 + 8 + 4
  const page = Buffer.concat([
    Buffer.from([0, 0, 1, 0]), u32le(2), u32le(off1), u32le(off1 + c1.length), u32le(0), c1, c2,
  ])
  let sum = 0
  for (let i = 0; i < page.length; i += 4) sum = (sum + page[i]) >>> 0
  return new Uint8Array(Buffer.concat([
    Buffer.from("cook"), u32be(1), u32be(page.length), page,
    u32be(sum), Buffer.from([0x07, 0x17, 0x20, 0x05, 0, 0, 0, 0x4b]),
    Buffer.from("bplist00fakemetadata"),
  ]))
})()

// ---------------- leveldb_log_parse ----------------
{
  const out = ok(api.leveldb_log_parse(simpleLog, "{}"))
  assert.equal(out.format, "leveldb_log")
  const r = out.result
  assert.equal(r.physical_records, 1)
  assert.equal(r.write_batches, 1)
  assert.equal(r.batch_entries, 3)
  assert.equal(r.record_count, 3)
  assert.equal(r.records[0].operation, "put")
  assert.equal(r.records[0].batch_sequence, 1000)
  assert.equal(r.records[0].key.utf8, "_http://a.com\x01key1")
  assert.equal(r.records[0].value.utf8, "value1")
  assert.equal(r.records[0].value.sha256, sha256(Buffer.from("value1")).toString("hex"))
  assert.equal(r.records[2].operation, "delete")
  assert.equal(r.records[2].sequence, 1002)
  checks += 13
}
{
  const out = ok(api.leveldb_log_parse(fragmentedLog, "{}"))
  assert.equal(out.result.record_count, 1)
  assert.equal(out.result.records[0].value.length, 40000)
  checks += 2
}
{
  const out = ok(api.leveldb_log_parse(corruptLog, "{}"))
  assert.equal(out.result.crc_failures, 1)
  assert.equal(out.result.corrupt_records, 1)
  assert.equal(out.result.record_count, 1)
  assert.equal(out.result.records[0].key.utf8, "next")
  assert.ok(out.warnings.length > 0)
  checks += 5
}
{
  const out = ok(api.leveldb_log_parse(manifestLog, "{}"))
  assert.equal(out.result.unparsed_records, 1)
  assert.equal(out.result.records[0].operation, "unparsed")
  checks += 2
  err(api.leveldb_log_parse(new Uint8Array(0), "{}"), "empty_input")
  err(api.leveldb_log_parse(new Uint8Array(4096).fill(0xaa), "{}"), "not_leveldb_log")
  err(api.leveldb_log_parse(new Uint8Array(32 * 1024 * 1024 + 1), "{}"), "input_too_large")
}

// ---------------- leveldb_table_parse ----------------
{
  const out = ok(api.leveldb_table_parse(sampleTable, "{}"))
  assert.equal(out.format, "leveldb_table")
  const r = out.result
  assert.equal(r.footer.magic, "0xdb4775248b80fb57")
  assert.equal(r.index_entry_count, 2)
  assert.equal(r.data_blocks_walked, 2)
  assert.equal(r.snappy_blocks, 1)
  assert.equal(r.record_count, 4)
  const recs = r.records
  assert.equal(recs[0].key.utf8, "alpha")
  assert.equal(recs[0].sequence, 100)
  assert.equal(recs[1].key.utf8, "alphabet")
  assert.equal(recs[2].operation, "delete")
  assert.equal(recs[2].key.utf8, "beta")
  assert.equal(recs[3].key.utf8, "gamma")
  assert.equal(r.metaindex_entries[0].key.utf8, "filter.leveldb.BuiltinBloomFilter2")
  checks += 12
}
{
  const out = ok(api.leveldb_table_parse(sampleTable, '{"include_index":true}'))
  assert.equal(out.result.index_entries.length, 2)
  assert.equal(out.result.index_entries[0].key.user_key.utf8, "alphabet")
  checks += 2
  const bad = Buffer.from(sampleTable)
  bad[bad.length - 1] ^= 0xff
  err(api.leveldb_table_parse(new Uint8Array(bad), "{}"), "invalid_sstable")
  err(api.leveldb_table_parse(new Uint8Array(20), "{}"), "invalid_sstable")
}

// ---------------- chrome_cache_parse ----------------
{
  const key = Buffer.from("https://example.com/x")
  const stream1 = Buffer.from("<html>hello</html>")
  const file = combinedEntry(key, stream1, responseInfoPickle, true)
  const out = ok(api.chrome_cache_parse(file, "{}"))
  assert.equal(out.format, "chrome_cache")
  const r = out.result
  assert.equal(r.layout, "combined")
  assert.equal(r.header.version, 5)
  assert.equal(r.header.key_hash_valid, true)
  assert.equal(r.key.utf8, "https://example.com/x")
  assert.equal(r.key_sha256, sha256(key).toString("hex"))
  assert.equal(r.key_sha256_valid, true)
  assert.equal(r.streams.length, 2)
  assert.equal(r.streams[0].index, 1)
  assert.equal(r.streams[0].data_length, stream1.length)
  assert.equal(r.streams[0].eof.crc32_valid, true)
  assert.equal(r.streams[1].index, 0)
  assert.equal(r.streams[1].eof.has_key_sha256, true)
  const info = r.streams[1].response_info
  assert.equal(info.version, 3)
  assert.equal(info.status_line, "HTTP/1.1 200 OK")
  assert.equal(info.header_count, 2)
  assert.equal(info.headers[0], "content-type: text/html")
  assert.ok(info.request_time.unix_seconds > 1600000000)
  assert.ok(info.original_response_time)
  checks += 18
}
{
  const out = ok(api.chrome_cache_parse(singleStreamEntry(Buffer.from("https://s2/"), Buffer.from("stream two data")), "{}"))
  assert.equal(out.result.layout, "single_stream")
  assert.equal(out.result.streams[0].index, 2)
  checks += 2
}
{
  const out = ok(api.chrome_cache_parse(sparseFile, "{}"))
  assert.equal(out.result.kind, "chrome_cache_sparse")
  assert.equal(out.result.range_count, 2)
  assert.equal(out.result.ranges[1].offset, 4096)
  checks += 3
}
err(api.chrome_cache_parse(Buffer.from("not a cache entry at all"), "{}"), "invalid_cache_entry")

// ---------------- safari_cookies_parse ----------------
{
  const out = ok(api.safari_cookies_parse(binarycookies, "{}"))
  assert.equal(out.format, "safari_cookies")
  const r = out.result
  assert.equal(r.page_count, 1)
  assert.equal(r.cookie_count, 2)
  const c1 = r.cookies[0]
  assert.equal(c1.domain, ".example.com")
  assert.equal(c1.name, "sess")
  assert.equal(c1.secure, true)
  assert.equal(c1.http_only, true)
  assert.equal(c1.value.utf8, "abc123")
  assert.equal(c1.expires_unix, 1678307200)
  assert.equal(r.checksum.valid, true)
  assert.equal(r.footer_valid, true)
  assert.equal(r.metadata.kind, "bplist")
  checks += 12
}
err(api.safari_cookies_parse(Buffer.from("not cookies"), "{}"), "invalid_binarycookies")

// ---------------- analyze + shared bounds ----------------
{
  assert.equal(ok(api.analyze(simpleLog, "{}")).format, "leveldb_log")
  assert.equal(ok(api.analyze(sampleTable, "{}")).format, "leveldb_table")
  assert.equal(ok(api.analyze(combinedEntry(Buffer.from("https://x/"), Buffer.from("b"), responseInfoPickle, true), "{}")).format, "chrome_cache")
  assert.equal(ok(api.analyze(binarycookies, "{}")).format, "safari_cookies")
  checks += 4
  err(api.analyze(new Uint8Array([1, 2, 3, 4]), "{}"), "unknown_artifact")
  err(api.analyze(new Uint8Array(0), "{}"), "empty_input")
  err(api.leveldb_log_parse(simpleLog, " ".repeat(4100)), "options_too_large")
  err(api.leveldb_log_parse(simpleLog, "{nope"), "invalid_options")
  err(api.leveldb_log_parse(simpleLog, "[1,2]"), "invalid_options")
}

// ---------------- determinism ----------------
{
  for (const [fn, fixture] of [
    [api.leveldb_log_parse, simpleLog],
    [api.leveldb_table_parse, sampleTable],
    [api.chrome_cache_parse, sparseFile],
    [api.safari_cookies_parse, binarycookies],
    [api.analyze, sampleTable],
  ]) {
    const first = fn(fixture, "{}")
    for (let i = 0; i < 3; i++) assert.equal(fn(fixture, "{}"), first)
    checks += 4
  }
}

// ---------------- fuzz: never panic, always JSON ----------------
{
  let state = 0x9e3779b97f4a7c15n
  const next = () => {
    state ^= state >> 12n
    state ^= (state << 25n) & 0xffffffffffffffffn
    state ^= state >> 27n
    state &= 0xffffffffffffffffn
    return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn
  }
  const ops = [
    api.analyze, api.leveldb_log_parse, api.leveldb_table_parse,
    api.chrome_cache_parse, api.safari_cookies_parse,
  ]
  for (let i = 0; i < 240; i++) {
    const len = 1 + Number(next() % 4096n)
    const buf = new Uint8Array(len)
    for (let j = 0; j < len; j++) buf[j] = Number(next() >> 32n) & 0xff
    for (const op of ops) {
      const out = op(buf, "{}")
      const value = JSON.parse(out)
      assert.equal(value.schema_version, 1)
      checks += 1
    }
  }
  // Mutated valid fixtures: bit flips must degrade, never throw.
  for (const fixture of [simpleLog, sampleTable, binarycookies, sparseFile]) {
    for (let i = 0; i < 40; i++) {
      const copy = Buffer.from(fixture)
      const pos = Number(next() % BigInt(copy.length))
      copy[pos] ^= 1 << Number(next() % 8n)
      for (const op of ops) {
        const value = JSON.parse(op(new Uint8Array(copy), "{}"))
        assert.equal(value.schema_version, 1)
        checks += 1
      }
    }
  }
}

console.log(`browser-artifacts WASM verified: ${checks} checks passed`)
