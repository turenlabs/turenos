import { describe, expect } from "bun:test"
import zlib from "node:zlib"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ApkDexRuntime } from "@turenlabs/core/tool/apk-dex-runtime"
import { ApkDexTools } from "@turenlabs/core/tool/apk-dex-tools"
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

// Byte builders ported from wasm-tools tools/apk-dex/test/verify.mjs — a binary
// AXML document, a minimal DEX, and a hand-built ZIP/APK container.
const te = new TextEncoder()
const str = (s: string) => te.encode(s)

function Writer() {
  const parts: Uint8Array[] = []
  const w = {
    u8(v: number) {
      parts.push(Uint8Array.of(v & 0xff))
      return w
    },
    u16(v: number) {
      const b = new Uint8Array(2)
      new DataView(b.buffer).setUint16(0, v, true)
      parts.push(b)
      return w
    },
    u32(v: number) {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setUint32(0, v >>> 0, true)
      parts.push(b)
      return w
    },
    bytes(b: Uint8Array | number[]) {
      parts.push(b instanceof Uint8Array ? b : Uint8Array.from(b))
      return w
    },
    get len() {
      return parts.reduce((n, p) => n + p.length, 0)
    },
    build() {
      const out = new Uint8Array(w.len)
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.length
      }
      return out
    },
  }
  return w
}

function uleb(v: number) {
  const out: number[] = []
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return out
}

function stringPool(strings: string[]) {
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const enc = strings.map((s) => {
    const b = str(s)
    const e: number[] = []
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
  for (const e of enc) {
    w.u32(rel)
    rel += e.length
  }
  for (const e of enc) w.bytes(e)
  while (w.len < size) w.u8(0)
  return w.build()
}

function node(type: number, body: Uint8Array) {
  const w = Writer()
  w.u16(type).u16(16).u32(16 + body.length)
  w.u32(1).u32(0xffffffff)
  w.bytes(body)
  return w.build()
}

function startElement(ns: number, name: number, attrs: [number, number, number, number, number][]) {
  const w = Writer()
  w.u32(ns).u32(name).u16(20).u16(20).u16(attrs.length).u16(0).u16(0).u16(0)
  for (const [aNs, aName, aRaw, aType, aData] of attrs) {
    w.u32(aNs).u32(aName).u32(aRaw).u16(8).u8(0).u8(aType).u32(aData)
  }
  return node(0x0102, w.build())
}

function endElement(ns: number, name: number) {
  const w = Writer()
  w.u32(ns).u32(name)
  return node(0x0103, w.build())
}

const AXML_STRINGS = [
  "manifest",
  "uses-sdk",
  "application",
  "activity",
  "http://schemas.android.com/apk/res/android",
  "android",
  "package",
  "name",
  "versionCode",
  "minSdkVersion",
  "exported",
  "com.example.app",
  ".MainActivity",
]

function buildAxml() {
  const NO = 0xffffffff
  const w = Writer()
  const parts = [stringPool(AXML_STRINGS)]
  const resIds = [0, 0, 0, 0, 0, 0, 0, 0x01010003, 0x0101021b, 0x0101020c, 0x01010010, 0, 0]
  const rm = Writer()
  rm.u16(0x0180).u16(8).u32(8 + resIds.length * 4)
  for (const id of resIds) rm.u32(id)
  parts.push(rm.build())
  parts.push(node(0x0100, Writer().u32(5).u32(4).build()))
  parts.push(
    startElement(NO, 0, [
      [NO, 6, 11, 0x03, 11],
      [4, 8, NO, 0x10, 33],
    ]),
  )
  parts.push(startElement(NO, 1, [[4, 9, NO, 0x10, 21]]))
  parts.push(endElement(NO, 1))
  parts.push(startElement(NO, 2, []))
  parts.push(
    startElement(NO, 3, [
      [4, 7, 12, 0x03, 12],
      [4, 10, NO, 0x12, 1],
    ]),
  )
  parts.push(endElement(NO, 3))
  parts.push(endElement(NO, 2))
  parts.push(endElement(NO, 0))
  parts.push(node(0x0101, Writer().u32(5).u32(4).build()))
  const body = parts.reduce((n, p) => n + p.length, 0)
  w.u16(0x0003).u16(8).u32(8 + body)
  for (const p of parts) w.bytes(p)
  return w.build()
}

const DEX_STRINGS = [
  "Lcom/example/app/MainActivity;",
  "Ljava/lang/Object;",
  "Landroid/app/Activity;",
  "MainActivity.java",
  "V",
  "VL",
  "onCreate",
  "<init>",
  "Landroid/os/Bundle;",
  "Ljava/lang/reflect/Method;",
  "Ljavax/crypto/Cipher;",
  "/system/bin/su",
  "Ldalvik/system/DexClassLoader;",
  "loadClass",
  "Ljava/lang/Runtime;",
  "exec",
  "I",
  "version",
]

function buildDex() {
  const NO = 0xffffffff
  const types = [0, 1, 2, 8, 4, 16, 9, 10, 12, 14]
  const protos: [number, number, number][] = [
    [4, 4, 0],
    [5, 4, NO],
  ]
  const fields = [[0, 5, 17]]
  const methods = [
    [0, 0, 7],
    [0, 1, 6],
    [8, 0, 13],
    [9, 0, 15],
  ]

  const header = 0x70
  const stringIdsOff = header
  const typeIdsOff = stringIdsOff + DEX_STRINGS.length * 4
  const protoIdsOff = typeIdsOff + types.length * 4
  const fieldIdsOff = protoIdsOff + protos.length * 12
  const methodIdsOff = fieldIdsOff + fields.length * 8
  const classDefsOff = methodIdsOff + methods.length * 8
  const dataOff = classDefsOff + 2 * 32

  const data: number[] = []
  const stringOffsets: number[] = []
  for (const s of DEX_STRINGS) {
    stringOffsets.push(dataOff + data.length)
    data.push(...uleb([...s].length), ...str(s), 0)
  }
  while (data.length % 4 !== 0) data.push(0)
  const paramsOff = dataOff + data.length
  const dv = (v: number) => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v, true)
    return [...b]
  }
  const dv2 = (v: number) => {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, v, true)
    return [...b]
  }
  data.push(...dv(1), ...dv2(3))
  while (data.length % 4 !== 0) data.push(0)

  const classData0 = dataOff + data.length
  data.push(...uleb(1), ...uleb(0), ...uleb(1), ...uleb(1))
  data.push(...uleb(0), ...uleb(0x9))
  data.push(...uleb(0), ...uleb(0x10001), ...uleb(0))
  data.push(...uleb(1), ...uleb(0x1), ...uleb(0))

  const classData1 = dataOff + data.length
  data.push(...uleb(0), ...uleb(0), ...uleb(1), ...uleb(0))
  data.push(...uleb(2), ...uleb(0x109), ...uleb(0))
  while (data.length % 4 !== 0) data.push(0)

  const mapOff = dataOff + data.length
  const mapItems = [
    [0x0000, 1, 0],
    [0x0001, DEX_STRINGS.length, stringIdsOff],
    [0x0002, types.length, typeIdsOff],
    [0x0003, protos.length, protoIdsOff],
    [0x0004, fields.length, fieldIdsOff],
    [0x0005, methods.length, methodIdsOff],
    [0x0006, 2, classDefsOff],
    [0x1001, 1, paramsOff],
    [0x2002, DEX_STRINGS.length, dataOff],
    [0x2000, 2, classData0],
    [0x1000, 1, mapOff],
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
  for (const [i, [shorty, ret, params]] of protos.entries())
    w.u32(shorty).u32(ret).u32(i === 1 ? paramsOff : params)
  for (const [c, t, n] of fields) w.u16(c).u16(t).u32(n)
  for (const [c, p, n] of methods) w.u16(c).u16(p).u32(n)
  w.u32(0).u32(1).u32(2).u32(0).u32(3).u32(0).u32(classData0).u32(0)
  w.u32(8).u32(1).u32(1).u32(0).u32(NO).u32(0).u32(classData1).u32(0)
  w.bytes(Uint8Array.from(data))
  return w.build()
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: { name: string; data: Uint8Array; method: 0 | 8 }[]) {
  const out: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = str(e.name)
    const payload = e.method === 8 ? new Uint8Array(zlib.deflateRawSync(e.data)) : e.data
    const crc = crc32(e.data)
    const local = Writer()
    local
      .u32(0x04034b50)
      .u16(20)
      .u16(0)
      .u16(e.method)
      .u16(0)
      .u16(0)
      .u32(crc)
      .u32(payload.length)
      .u32(e.data.length)
      .u16(name.length)
      .u16(0)
      .bytes(name)
    const lh = local.build()
    out.push(lh, payload)
    const central = Writer()
    central
      .u32(0x02014b50)
      .u16(20)
      .u16(20)
      .u16(0)
      .u16(e.method)
      .u16(0)
      .u16(0)
      .u32(crc)
      .u32(payload.length)
      .u32(e.data.length)
      .u16(name.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(offset)
      .bytes(name)
    centrals.push(central.build())
    offset += lh.length + payload.length
  }
  const cdStart = offset
  let cdSize = 0
  for (const c of centrals) {
    out.push(c)
    cdSize += c.length
  }
  const eocd = Writer()
  eocd.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length).u32(cdSize).u32(cdStart).u16(0)
  out.push(eocd.build())
  const zip = new Uint8Array(out.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of out) {
    zip.set(p, pos)
    pos += p.length
  }
  return zip
}

describe("ApkDexRuntime and ApkDexTools", () => {
  it.live("decodes and inspects Android fixtures through a fresh apk-dex worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const axml = buildAxml()
          const dex = buildDex()
          const apk = buildZip([
            { name: "AndroidManifest.xml", data: axml, method: 8 },
            { name: "classes.dex", data: dex, method: 0 },
            { name: "META-INF/CERT.SF", data: str("Signature-Version: 1.0\r\n"), method: 0 },
          ])
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/AndroidManifest.xml`, axml),
              Bun.write(`${tmp.path}/classes.dex`, dex),
              Bun.write(`${tmp.path}/app.apk`, apk),
              Bun.write(`${tmp.path}/garbage.bin`, str("not xml at all")),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["apk_inspect", "axml_decode", "dex_inspect"]) expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_apk_dex_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const decoded = yield* call("call-axml-decode", "axml_decode", { path: "AndroidManifest.xml" })
          expect(decoded.type).toBe("text")
          if (decoded.type !== "text") return
          expect(decoded.value).toContain('"kind": "axml"')
          expect(decoded.value).toContain('"elements": 4')
          expect(decoded.value).toContain('package=\\"com.example.app\\"')
          expect(decoded.value).toContain('"prefix": "android"')
          expect(decoded.value).toContain('"count": 13')

          const dexed = yield* call("call-dex-inspect", "dex_inspect", { path: "classes.dex" })
          expect(dexed.type).toBe("text")
          if (dexed.type !== "text") return
          expect(dexed.value).toContain('"kind": "dex"')
          expect(dexed.value).toContain('"version": "035"')
          expect(dexed.value).toContain('"name": "Lcom/example/app/MainActivity;"')
          expect(dexed.value).toContain('"superclass": "Landroid/app/Activity;"')
          expect(dexed.value).toContain('"kind": "crypto"')

          const apked = yield* call("call-apk-inspect", "apk_inspect", { path: "app.apk" })
          expect(apked.type).toBe("text")
          if (apked.type !== "text") return
          expect(apked.value).toContain('"kind": "apk"')
          expect(apked.value).toContain('"entry_count": 3')
          expect(apked.value).toContain('"name": "AndroidManifest.xml"')
          expect(apked.value).toContain('"decoded": true')
          expect(apked.value).toContain('"dex_version": "035"')
          expect(apked.value).toContain('"v1_signed": true')

          const viaApk = yield* call("call-dex-inspect-apk", "dex_inspect", { path: "app.apk", dexIndex: 1 })
          expect(viaApk.type).toBe("text")
          if (viaApk.type !== "text") return
          expect(viaApk.value).toContain('"kind": "dex"')
          expect(viaApk.value).toContain('"classes": 2')

          const failed = yield* call("call-axml-decode-bad", "axml_decode", { path: "garbage.bin" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                ApkDexRuntime.node,
                ApkDexTools.node,
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
