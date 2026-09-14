import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { BrowserArtifactsRuntime } from "@turenlabs/core/tool/browser-artifacts-runtime"
import { BrowserArtifactsTools } from "@turenlabs/core/tool/browser-artifacts-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

// Fixtures ported from wasm-tools tools/browser-artifacts/test/verify.mjs.
const u16le = (v: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}
const u32le = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}
const u32be = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0)
  return b
}
const u64le = (v: number | bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v))
  return b
}
const f64le = (v: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(v)
  return b
}

const varint = (v: number | bigint) => {
  const out: number[] = []
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
const crc32c = (data: Buffer) => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1
  }
  return ~crc >>> 0
}
const maskCrc = (crc: number) => (((crc >>> 15) | ((crc << 17) >>> 0)) + 0xa282ead8) >>> 0
const recordCrc = (type: number, data: Buffer) => maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data])))

// zlib CRC-32 (IEEE) for simple-cache EOF records.
const crc32ieee = (data: Buffer) => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return ~crc >>> 0
}

// Chromium base::PersistentHash (SuperFastHash).
const superFastHash = (data: Buffer) => {
  const get16 = (d: Buffer, i: number) => d[i] | (d[i + 1] << 8)
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

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest()

// ---------------- LevelDB log fixture ----------------
const BLOCK = 32768
const FULL = 1

const logRecord = (type: number, data: Buffer) =>
  Buffer.concat([u32le(recordCrc(type, data)), u16le(data.length), Buffer.from([type]), data])

const writeBatch = (seq: number, entries: ReadonlyArray<readonly [number, Buffer, Buffer | null]>) => {
  const parts: Buffer[] = [u64le(seq), u32le(entries.length)]
  for (const [tag, key, value] of entries) {
    parts.push(Buffer.from([tag]), varint(key.length), key)
    if (value !== null) parts.push(varint(value.length), value)
  }
  return Buffer.concat(parts)
}

const padBlock = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc(BLOCK - buf.length)])

const simpleLog = new Uint8Array(
  padBlock(
    logRecord(
      FULL,
      writeBatch(1000, [
        [1, Buffer.from("_http://a.com\x01key1"), Buffer.from("value1")],
        [1, Buffer.from("key2"), Buffer.from("value2")],
        [0, Buffer.from("oldkey"), null],
      ]),
    ),
  ),
)

// ---------------- LevelDB table fixture ----------------
const TABLE_MAGIC = 0xdb4775248b80fb57n

const internalKey = (user: string, seq: number, type: number) =>
  Buffer.concat([Buffer.from(user), u64le((BigInt(seq) << 8n) | BigInt(type))])

const buildBlock = (entries: ReadonlyArray<readonly [Buffer, Buffer]>, restartInterval = 4) => {
  const out: Buffer[] = []
  const restarts: number[] = []
  let lastKey: Buffer = Buffer.alloc(0)
  entries.forEach(([key, value], i) => {
    let shared = 0
    if (i % restartInterval === 0) {
      restarts.push(out.reduce((n, b) => n + b.length, 0))
    } else {
      while (shared < key.length && shared < lastKey.length && key[shared] === lastKey[shared]) shared++
    }
    out.push(varint(shared), varint(key.length - shared), varint(value.length), key.subarray(shared), value)
    lastKey = key
  })
  for (const r of restarts) out.push(u32le(r))
  out.push(u32le(restarts.length))
  return Buffer.concat(out)
}

const blockOnDisk = (contents: Buffer, compression: number) => {
  const crc = maskCrc(crc32c(Buffer.concat([contents, Buffer.from([compression])])))
  return Buffer.concat([contents, Buffer.from([compression]), u32le(crc)])
}

const snappyLiteral = (data: Buffer) => {
  const out: Buffer[] = [varint(data.length)]
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

const handleBytes = (offset: number, size: number) => Buffer.concat([varint(offset), varint(size)])

const sampleTable = (() => {
  const data1 = buildBlock([
    [internalKey("alpha", 100, 1), Buffer.from("v1")],
    [internalKey("alphabet", 99, 1), Buffer.from("v2")],
    [internalKey("beta", 98, 0), Buffer.alloc(0)],
  ])
  const data2 = buildBlock([[internalKey("gamma", 97, 1), Buffer.from("gval")]], 1)
  const metaindex = buildBlock([[Buffer.from("filter.leveldb.BuiltinBloomFilter2"), handleBytes(0, 0)]], 1)
  const file: Buffer[] = []
  const d1Off = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(data1, 0))
  const d2Off = file.reduce((n, b) => n + b.length, 0)
  const snappy = snappyLiteral(data2)
  file.push(blockOnDisk(snappy, 1))
  const metaOff = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(metaindex, 0))
  const index = buildBlock(
    [
      [internalKey("alphabet", 99, 1), handleBytes(d1Off, data1.length)],
      [internalKey("zzz", 1, 1), handleBytes(d2Off, snappy.length)],
    ],
    1,
  )
  const idxOff = file.reduce((n, b) => n + b.length, 0)
  file.push(blockOnDisk(index, 0))
  const footer = Buffer.concat([handleBytes(metaOff, metaindex.length), handleBytes(idxOff, index.length)])
  const padded = Buffer.concat([footer, Buffer.alloc(40 - footer.length), u64le(TABLE_MAGIC)])
  file.push(padded)
  return new Uint8Array(Buffer.concat(file))
})()

// ---------------- simple cache fixture ----------------
const INITIAL_MAGIC = 0xfcfb6d1ba7725c30n
const FINAL_MAGIC = 0xf4fa6f45970d41d8n

const eofRecord = (flags: number, crc: number, streamSize: number) =>
  Buffer.concat([u64le(FINAL_MAGIC), u32le(flags), u32le(crc), u32le(streamSize), u32le(0)])

const cacheHeader = (key: Buffer) =>
  Buffer.concat([u64le(INITIAL_MAGIC), u32le(5), u32le(key.length), u32le(superFastHash(key)), u32le(0), key])

const responseInfoPickle = (() => {
  const headers = Buffer.from("HTTP/1.1 200 OK\0content-type: text/html\0content-length: 5\0\0")
  const payload = Buffer.concat([
    u32le(0x80000003),
    u32le(4),
    u64le(13340000000000000n),
    u64le(13340000001000000n),
    u64le(13340000000500000n),
    u32le(headers.length),
    headers,
  ])
  const pad = Buffer.alloc((4 - (payload.length % 4)) % 4)
  return Buffer.concat([u32le(payload.length + pad.length), payload, pad])
})()

const combinedEntry = (key: Buffer, stream1: Buffer, stream0: Buffer, withSha: boolean) => {
  const parts = [cacheHeader(key), stream1, eofRecord(1, crc32ieee(stream1), 0), stream0]
  if (withSha) parts.push(sha256(key))
  parts.push(eofRecord(withSha ? 3 : 1, crc32ieee(stream0), stream0.length))
  return new Uint8Array(Buffer.concat(parts))
}

// ---------------- binarycookies fixture ----------------
const cookieRecord = (
  domain: string,
  name: string,
  path: string,
  value: string,
  flags: number,
  expires: number,
  created: number,
) => {
  const strings = Buffer.concat([domain, name, path, value].map((s) => Buffer.from(s + "\0")))
  const offs: Buffer[] = []
  let p = 56
  for (const s of [domain, name, path, value]) {
    offs.push(u32le(p))
    p += s.length + 1
  }
  return Buffer.concat([
    u32le(56 + strings.length),
    u32le(1),
    u32le(flags),
    u32le(0),
    ...offs,
    u64le(0n),
    f64le(expires),
    f64le(created),
    strings,
  ])
}

const binarycookies = (() => {
  const c1 = cookieRecord(".example.com", "sess", "/", "abc123", 5, 700000000.0, 600000000.0)
  const c2 = cookieRecord(".other.net", "pref", "/p", "x", 0, 800000000.0, 500000000.0)
  const off1 = 8 + 8 + 4
  const page = Buffer.concat([
    Buffer.from([0, 0, 1, 0]),
    u32le(2),
    u32le(off1),
    u32le(off1 + c1.length),
    u32le(0),
    c1,
    c2,
  ])
  let sum = 0
  for (let i = 0; i < page.length; i += 4) sum = (sum + page[i]) >>> 0
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("cook"),
      u32be(1),
      u32be(page.length),
      page,
      u32be(sum),
      Buffer.from([0x07, 0x17, 0x20, 0x05, 0, 0, 0, 0x4b]),
      Buffer.from("bplist00fakemetadata"),
    ]),
  )
})()

describe("BrowserArtifactsRuntime and BrowserArtifactsTools", () => {
  it.live("parses browser artifact fixtures through a fresh browser-artifacts worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const cacheKey = Buffer.from("https://example.com/x")
          const stream1 = Buffer.from("<html>hello</html>")
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/000003.log`, simpleLog),
              Bun.write(`${tmp.path}/000004.ldb`, sampleTable),
              Bun.write(`${tmp.path}/f_000001`, combinedEntry(cacheKey, stream1, responseInfoPickle, true)),
              Bun.write(`${tmp.path}/Cookies.binarycookies`, binarycookies),
              Bun.write(`${tmp.path}/zeros.log`, new Uint8Array(4096).fill(0xaa)),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "leveldb_log_parse",
            "leveldb_table_parse",
            "chrome_cache_parse",
            "safari_cookies_parse",
            "browser_analyze",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_browser_artifacts_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const log = yield* call("call-leveldb-log-parse", "leveldb_log_parse", { path: "000003.log" })
          expect(log.type).toBe("text")
          if (log.type !== "text") return
          expect(log.value).toContain('"format": "leveldb_log"')
          expect(log.value).toContain('"batch_entries": 3')
          expect(log.value).toContain('"record_count": 3')
          expect(log.value).toContain('"operation": "put"')
          expect(log.value).toContain('"operation": "delete"')
          expect(log.value).toContain('"batch_sequence": 1000')

          const table = yield* call("call-leveldb-table-parse", "leveldb_table_parse", { path: "000004.ldb" })
          expect(table.type).toBe("text")
          if (table.type !== "text") return
          expect(table.value).toContain('"format": "leveldb_table"')
          expect(table.value).toContain('"magic": "0xdb4775248b80fb57"')
          expect(table.value).toContain('"data_blocks_walked": 2')
          expect(table.value).toContain('"snappy_blocks": 1')
          expect(table.value).toContain('"record_count": 4')
          expect(table.value).toContain('"alpha"')
          expect(table.value).toContain('"operation": "delete"')

          const cache = yield* call("call-chrome-cache-parse", "chrome_cache_parse", { path: "f_000001" })
          expect(cache.type).toBe("text")
          if (cache.type !== "text") return
          expect(cache.value).toContain('"format": "chrome_cache"')
          expect(cache.value).toContain('"layout": "combined"')
          expect(cache.value).toContain('"key_hash_valid": true')
          expect(cache.value).toContain('"https://example.com/x"')
          expect(cache.value).toContain('"key_sha256_valid": true')
          expect(cache.value).toContain('"HTTP/1.1 200 OK"')
          expect(cache.value).toContain('"content-type: text/html"')

          const cookies = yield* call("call-safari-cookies-parse", "safari_cookies_parse", {
            path: "Cookies.binarycookies",
          })
          expect(cookies.type).toBe("text")
          if (cookies.type !== "text") return
          expect(cookies.value).toContain('"format": "safari_cookies"')
          expect(cookies.value).toContain('"page_count": 1')
          expect(cookies.value).toContain('"cookie_count": 2')
          expect(cookies.value).toContain('"domain": ".example.com"')
          expect(cookies.value).toContain('"name": "sess"')
          expect(cookies.value).toContain('"secure": true')
          expect(cookies.value).toContain('"http_only": true')
          expect(cookies.value).toContain('"abc123"')

          const sniffed = yield* call("call-browser-analyze", "browser_analyze", {
            path: "Cookies.binarycookies",
          })
          expect(sniffed.type).toBe("text")
          if (sniffed.type !== "text") return
          expect(sniffed.value).toContain('"format": "safari_cookies"')

          const failed = yield* call("call-leveldb-log-parse-bad", "leveldb_log_parse", { path: "zeros.log" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                BrowserArtifactsRuntime.node,
                BrowserArtifactsTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
