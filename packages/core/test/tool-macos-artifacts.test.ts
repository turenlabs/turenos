import { gzipSync } from "node:zlib"
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
import { MacosArtifactsRuntime } from "@turenlabs/core/tool/macos-artifacts-runtime"
import { MacosArtifactsTools } from "@turenlabs/core/tool/macos-artifacts-tools"
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

// Fixtures ported from wasm-tools tools/macos-artifacts/test/verify.mjs.
const u16le = (v: number) => Buffer.from([v & 0xff, (v >> 8) & 0xff])
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
const u64be = (v: number | bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(v))
  return b
}
const be128 = (v: bigint) => {
  const b = Buffer.alloc(16)
  b.writeBigUInt64BE(v >> 64n)
  b.writeBigUInt64BE(v & 0xffffffffffffffffn, 8)
  return b
}
const pad8 = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc((8 - (buf.length % 8)) % 8)])

// Hand-assembled bplist00: one dict {"Name": "Fixture"}.
const bplist = (() => {
  const objects = Buffer.concat([
    Buffer.from([0xd1, 0x01, 0x02]),
    Buffer.from([0x54, ...Buffer.from("Name", "ascii")]),
    Buffer.from([0x57, ...Buffer.from("Fixture", "ascii")]),
  ])
  const offsets = Buffer.from([8, 11, 16])
  const trailer = Buffer.concat([
    Buffer.alloc(6),
    Buffer.from([1, 1]),
    u64be(3),
    u64be(0),
    u64be(8 + objects.length),
  ])
  return new Uint8Array(Buffer.concat([Buffer.from("bplist00"), objects, offsets, trailer]))
})()

const xmlPlist = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Fixture</string>
<key>Count</key><integer>42</integer>
</dict></plist>`)

const fsevents = (() => {
  const record = (path: string, eventId: number, flags: number, nodeId: number | null, v3: boolean) =>
    Buffer.concat([
      Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0])]),
      u64le(eventId),
      u32le(flags),
      nodeId === null ? Buffer.alloc(0) : u64le(nodeId),
      v3 ? u32le(0xa5a5a5a5) : Buffer.alloc(0),
    ])
  const page = (magic: string, records: Buffer) =>
    Buffer.concat([Buffer.from(magic), u32le(0), u32le(12 + records.length), records])
  const stream = Buffer.concat([
    page("2SLD", record("/Users/test/file.txt", 0x1122, 0x1 | 0x00800000, 99, false)),
    page("2SLD", record("/Users/test/gone", 0x1123, 0x2 | 0x01000000, 100, false)),
    page("3SLD", record("/tmp/x", 0x99, 0x8 | 0x10, 7, true)),
  ])
  return new Uint8Array(gzipSync(stream))
})()

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
  u32be((2084 - 4) | 5).copy(root, 8)
  u32be((2116 - 4) | 8).copy(root, 12)
  u32be(1).copy(root, 8 + 1024)
  root.writeUInt8(4, 8 + 1028)
  root.write("DSDB", 8 + 1029)
  u32be(0).copy(root, 8 + 1033)
  file.set(root, 36)

  const superblock = Buffer.concat([1, 1, 3, 1, 4096].map(u32be))
  file.set(superblock, 2084)

  const utf16be = (s: string) => Buffer.concat([...s].map((c) => u32be(c.charCodeAt(0)).subarray(2)))
  const entry = (name: string, code: string, type: string, value: Buffer) =>
    Buffer.concat([u32be(name.length), utf16be(name), Buffer.from(code), Buffer.from(type), value])
  const leaf = Buffer.concat([
    u32be(0),
    u32be(3),
    entry(
      "Icon",
      "Iloc",
      "blob",
      Buffer.concat([u32be(16), u32be(10), u32be(20), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0])]),
    ),
    entry("Notes", "vSrn", "long", u32be(7)),
    entry("Doc", "dscl", "ustr", Buffer.concat([u32be(5), utf16be("hello")])),
  ])
  const padded = Buffer.alloc(256)
  leaf.copy(padded)
  file.set(padded, 2116)
  return new Uint8Array(file)
})()

const preamble = (tag: number, subTag: number, data: Buffer) =>
  pad8(Buffer.concat([u32le(tag), u32le(subTag), u64le(data.length), data]))
const tracev3 = (() => {
  const header = (() => {
    const build = Buffer.alloc(16)
    build.write("24A335")
    const model = Buffer.alloc(32)
    model.write("MacBookPro18,3")
    const tz = Buffer.alloc(48)
    tz.write("/var/db/timezone/zoneinfo/UTC")
    return preamble(
      0x1000,
      0x11,
      Buffer.concat([
        u32le(1),
        u32le(1),
        u64le(1000),
        u64le(0),
        u32le(0),
        u32le(0),
        u32le(0),
        u32le(0),
        u32le(0x6100),
        u32le(16),
        u64le(999),
        u32le(0x6101),
        u32le(16),
        u32le(0),
        u32le(0),
        build,
        model,
        u32le(0x6102),
        u32le(24),
        be128(0x00112233445566778899aabbccddeeFFn),
        u32le(77),
        u32le(0),
        u32le(0x6103),
        u32le(48),
        tz,
      ]),
    )
  })()
  const catalog = (() => {
    const strings = Buffer.from("com.turen.test\0default\0")
    const procEntry = Buffer.concat([
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u64le(1),
      u32le(1),
      u32le(501),
      u32le(20),
      u32le(0),
      u32le(1),
      u32le(0),
      u32le(16),
      u32le(0),
      u16le(0),
      Buffer.alloc(6),
      u32le(1),
      u32le(0),
      u16le(7),
      u16le(0),
      u16le(15),
      Buffer.alloc(2),
    ])
    const subchunk = Buffer.concat([
      u64le(0),
      u64le(70),
      u32le(70),
      u32le(0x100),
      u32le(1),
      u16le(0),
      u32le(0),
      Buffer.alloc(6),
    ])
    const sso = 16
    const pieo = sso + strings.length
    const osc = pieo + procEntry.length
    return preamble(
      0x600b,
      0x11,
      Buffer.concat([
        u16le(sso),
        u16le(pieo),
        u16le(1),
        u16le(osc),
        u16le(1),
        Buffer.alloc(6),
        u64le(1000),
        be128(0x00112233445566778899aabbccddeeFFn),
        strings,
        procEntry,
        subchunk,
      ]),
    )
  })()
  const chunkset = (() => {
    const entry = Buffer.concat([
      Buffer.from([0x4, 0x1]),
      u16le(0x202),
      u32le(0x100),
      u64le(0x1234),
      u32le(5),
      u16le(0),
      u16le(6),
      u32le(0xdeadbeef),
      u16le(7),
    ])
    const firehose = preamble(
      0x6001,
      0x11,
      Buffer.concat([
        u64le(1),
        u32le(1),
        Buffer.from([0, 0, 0, 0]),
        u16le(16 + entry.length),
        u16le(0x1000),
        Buffer.alloc(4),
        u64le(0),
        entry,
      ]),
    )
    return preamble(
      0x600d,
      0x11,
      Buffer.concat([u32le(758412898), u32le(firehose.length), firehose, u32le(0x24347662)]),
    )
  })()
  return new Uint8Array(Buffer.concat([header, catalog, chunkset]))
})()

describe("MacosArtifactsRuntime and MacosArtifactsTools", () => {
  it.live("parses macOS artifact fixtures through a fresh macos-artifacts worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/bplist`, bplist),
              Bun.write(`${tmp.path}/info.plist`, xmlPlist),
              Bun.write(`${tmp.path}/0000000000000001`, fsevents),
              Bun.write(`${tmp.path}/.DS_Store`, dsStore),
              Bun.write(`${tmp.path}/log.tracev3`, tracev3),
              Bun.write(`${tmp.path}/garbage.plist`, new TextEncoder().encode("not a plist at all")),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "plist_parse",
            "fsevents_parse",
            "unified_log_parse",
            "ds_store_parse",
            "macos_analyze",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_macos_artifacts_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const plist = yield* call("call-plist-parse", "plist_parse", { path: "bplist" })
          expect(plist.type).toBe("text")
          if (plist.type !== "text") return
          expect(plist.value).toContain('"format": "plist"')
          expect(plist.value).toContain('"encoding": "binary"')
          expect(plist.value).toContain('"Name": "Fixture"')

          const xml = yield* call("call-plist-parse-xml", "plist_parse", { path: "info.plist" })
          expect(xml.type).toBe("text")
          if (xml.type !== "text") return
          expect(xml.value).toContain('"encoding": "xml"')
          expect(xml.value).toContain('"Name": "Fixture"')
          expect(xml.value).toContain('"Count": 42')

          const events = yield* call("call-fsevents-parse", "fsevents_parse", { path: "0000000000000001" })
          expect(events.type).toBe("text")
          if (events.type !== "text") return
          expect(events.value).toContain('"format": "fsevents"')
          expect(events.value).toContain('"page_count": 3')
          expect(events.value).toContain('"record_count": 3')
          expect(events.value).toContain('"/Users/test/file.txt"')
          expect(events.value).toContain('"Created"')
          expect(events.value).toContain('"Removed"')

          const store = yield* call("call-ds-store-parse", "ds_store_parse", { path: ".DS_Store" })
          expect(store.type).toBe("text")
          if (store.type !== "text") return
          expect(store.value).toContain('"format": "ds_store"')
          expect(store.value).toContain('"record_count": 3')
          expect(store.value).toContain('"filename": "Icon"')
          expect(store.value).toContain('"x": 10')
          expect(store.value).toContain('"value": "hello"')

          const log = yield* call("call-unified-log-parse", "unified_log_parse", { path: "log.tracev3" })
          expect(log.type).toBe("text")
          if (log.type !== "text") return
          expect(log.value).toContain('"format": "unified_log"')
          expect(log.value).toContain('"boot_uuid": "00112233445566778899AABBCCDDEEFF"')
          expect(log.value).toContain('"logd_pid": 77')
          expect(log.value).toContain('"entry_count": 1')
          expect(log.value).toContain('"subsystem": "com.turen.test"')
          expect(log.value).toContain('"missing_message_entries": 1')

          const sniffed = yield* call("call-macos-analyze", "macos_analyze", { path: "0000000000000001" })
          expect(sniffed.type).toBe("text")
          if (sniffed.type !== "text") return
          expect(sniffed.value).toContain('"format": "fsevents"')

          const failed = yield* call("call-plist-parse-bad", "plist_parse", { path: "garbage.plist" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                MacosArtifactsRuntime.node,
                MacosArtifactsTools.node,
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
