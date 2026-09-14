import fs from "node:fs/promises"
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
import { FirmwareFormatsRuntime } from "@turenlabs/core/tool/firmware-formats-runtime"
import { FirmwareFormatsTools } from "@turenlabs/core/tool/firmware-formats-tools"
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

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        FirmwareFormatsRuntime.node,
        FirmwareFormatsTools.node,
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
  )

// ---- fixture builders (ported from tools/firmware-formats/test/verify.mjs) --

const text = (value: string) => new TextEncoder().encode(value)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let cell = i
    for (let bit = 0; bit < 8; bit += 1) cell = cell & 1 ? 0xedb88320 ^ (cell >>> 1) : cell >>> 1
    table[i] = cell
  }
  return table
})()

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

const buildDtb = () => {
  const strings = text("compatible\0reg\0flag\0status\0")
  const off = { compatible: 0, reg: 11, flag: 15, status: 20 }
  const struct: number[] = []
  const u32 = (value: number) =>
    struct.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  const align = () => {
    while (struct.length % 4) struct.push(0)
  }
  const begin = (name: string) => {
    u32(1)
    for (const ch of name) struct.push(ch.charCodeAt(0))
    struct.push(0)
    align()
  }
  const end = () => u32(2)
  const prop = (name: keyof typeof off, data: Uint8Array | number[]) => {
    u32(3)
    u32(data.length)
    u32(off[name])
    struct.push(...data)
    align()
  }

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
  const out: number[] = []
  const w32 = (value: number) => out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  const w64 = (value: number) => {
    w32(Math.floor(value / 2 ** 32))
    w32(value >>> 0)
  }
  w32(0xd00dfeed)
  w32(total)
  w32(structOff)
  w32(stringsOff)
  w32(rsvmapOff)
  w32(17)
  w32(16)
  w32(0)
  w32(strings.length)
  w32(struct.length)
  w64(0x80000000)
  w64(0x1000)
  w64(0)
  w64(0) // one memreserve + terminator
  out.push(...struct, ...strings)
  return new Uint8Array(out)
}

const buildUimage = (data: Uint8Array) => {
  const header = new Uint8Array(64)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x27051956)
  view.setUint32(8, 0x66000100)
  view.setUint32(12, data.length)
  view.setUint32(16, 0x80008000)
  view.setUint32(20, 0x80008000)
  view.setUint32(24, crc32(data))
  header.set([5, 2, 2, 1], 28) // linux, arm, kernel, gzip
  header.set(text("Linux-6.1"), 32)
  const zeroed = new Uint8Array(header)
  zeroed.fill(0, 4, 8)
  view.setUint32(4, crc32(zeroed))
  const out = new Uint8Array(64 + data.length)
  out.set(header)
  out.set(data, 64)
  return out
}

const buildEnv = (entries: ReadonlyArray<readonly [string, string]>) => {
  const data: number[] = []
  for (const [key, value] of entries) data.push(...text(`${key}=${value}`), 0)
  data.push(0)
  const checksum = crc32(new Uint8Array(data))
  return new Uint8Array([
    checksum & 255,
    (checksum >>> 8) & 255,
    (checksum >>> 16) & 255,
    checksum >>> 24,
    ...data,
  ])
}

const ihexLine = (count: number, address: number, rtype: number, data: number[] = []) => {
  const bytes = [count, (address >> 8) & 255, address & 255, rtype, ...data]
  const checksum = -bytes.reduce((a, b) => a + b, 0) & 255
  const hex = (value: number, width: number) => value.toString(16).toUpperCase().padStart(width, "0")
  return `:${hex(count, 2)}${hex(address, 4)}${hex(rtype, 2)}${data.map((b) => hex(b, 2)).join("")}${hex(checksum, 2)}\n`
}

const srecLine = (rtype: number, address: number, data: number[] = []) => {
  const alen = { 0: 2, 1: 2, 5: 2, 9: 2, 2: 3, 6: 3, 8: 3, 3: 4, 7: 4 }[rtype] ?? 2
  const count = alen + data.length + 1
  const addrBytes = []
  for (let shift = (alen - 1) * 8; shift >= 0; shift -= 8) addrBytes.push((address >> shift) & 255)
  const checksum = ~[count, ...addrBytes, ...data].reduce((a, b) => a + b, 0) & 255
  const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0")
  return `S${rtype}${hex(count)}${[...addrBytes, ...data, checksum].map(hex).join("")}\n`
}

const buildSparse = (chunks: ReadonlyArray<readonly [number, number, number[]]>, blockSize = 4096) => {
  const totalBlocks = chunks.reduce((sum, [kind, blocks]) => sum + (kind === 0xcac4 ? 0 : blocks), 0)
  const out: number[] = []
  const w16 = (v: number) => out.push(v & 255, (v >> 8) & 255)
  const w32 = (v: number) => out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255)
  w32(0xed26ff3a)
  w16(1)
  w16(0)
  w16(28)
  w16(12)
  w32(blockSize)
  w32(totalBlocks)
  w32(chunks.length)
  w32(0)
  for (const [kind, blocks, payload] of chunks) {
    w16(kind)
    w16(0)
    w32(blocks)
    w32(12 + payload.length)
    out.push(...payload)
  }
  return new Uint8Array(out)
}

const IHEX =
  ihexLine(2, 0, 4, [0x08, 0x00]) +
  ihexLine(4, 0x0100, 0, [0xde, 0xad, 0xbe, 0xef]) +
  ihexLine(4, 0x0200, 0, [1, 2, 3, 4]) +
  ihexLine(4, 0, 5, [0x08, 0x00, 0x01, 0x00]) +
  ihexLine(0, 0, 1)

const SREC =
  srecLine(0, 0, Array.from(text("HDR"))) +
  srecLine(1, 0x0100, [0xde, 0xad, 0xbe, 0xef]) +
  srecLine(1, 0x0200, [1, 2, 3, 4]) +
  srecLine(5, 2) +
  srecLine(9, 0x0100)

const RAW_BLOCK = new Array(4096).fill(0x41)
const FILL_PATTERN = [0x11, 0x22, 0x33, 0x44]
const EXPANDED = new Uint8Array(16384)
EXPANDED.fill(0x41, 0, 4096)
for (let i = 4096; i < 12288; i += 1) EXPANDED[i] = FILL_PATTERN[i % 4]!
const SPARSE_CRC = crc32(EXPANDED)
const SPARSE = buildSparse([
  [0xcac1, 1, RAW_BLOCK],
  [0xcac2, 2, FILL_PATTERN],
  [0xcac3, 1, []],
  [0xcac4, 0, [SPARSE_CRC & 255, (SPARSE_CRC >> 8) & 255, (SPARSE_CRC >> 16) & 255, SPARSE_CRC >>> 24]],
])

const artifact = async (value: unknown) => {
  const path = / to (\S+) \(sha256/.exec(String(value))?.[1]
  expect(path).toBeTruthy()
  return fs.readFile(path!)
}

describe("FirmwareFormatsRuntime and FirmwareFormatsTools", () => {
  it.live("decodes firmware formats through a fresh firmware-formats worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/fixture.dtb`, buildDtb()))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/uImage`, buildUimage(text("fake kernel bytes"))))
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/env.bin`, buildEnv([["bootcmd", "run distro_bootcmd"], ["baudrate", "115200"]])),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/image.hex`, IHEX))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/image.srec`, SREC))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sparse.img`, SPARSE))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.bin`, "definitely not firmware"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of [
            "android_sparse_expand",
            "android_sparse_parse",
            "dtb_decompile",
            "ihex_flatten",
            "ihex_parse",
            "srec_flatten",
            "srec_parse",
            "uboot_env_parse",
            "uimage_inspect",
          ])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_firmware_formats_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const uimage = yield* call("call-uimage", "uimage_inspect", { path: "uImage" })
          expect(uimage.type).toBe("text")
          if (uimage.type !== "text") return
          expect(uimage.value).toContain('"kind": "uimage"')
          expect(uimage.value).toContain('"name": "Linux-6.1"')
          expect(uimage.value).toContain('"os_name": "linux"')
          expect(uimage.value).toContain('"arch_name": "arm"')
          expect(uimage.value).toContain('"type_name": "kernel"')
          expect(uimage.value).toContain('"compression_name": "gzip"')
          expect(uimage.value).toContain('"valid": true')
          expect(uimage.value).toContain('"data_present": true')

          const env = yield* call("call-uboot-env", "uboot_env_parse", { path: "env.bin" })
          expect(env.type).toBe("text")
          if (env.type !== "text") return
          expect(env.value).toContain('"kind": "uboot-env"')
          expect(env.value).toContain('"redundancy": "none"')
          expect(env.value).toContain('"key": "bootcmd"')
          expect(env.value).toContain('"value": "run distro_bootcmd"')
          expect(env.value).toContain('"endianness": "little"')
          expect(env.value).toContain('"terminated": true')

          const dtb = yield* call("call-dtb", "dtb_decompile", { path: "fixture.dtb" })
          expect(dtb.type).toBe("text")
          if (dtb.type !== "text") return
          expect(dtb.value).toContain('"kind": "dtb"')
          expect(dtb.value).toContain('"node_count": 2')
          expect(dtb.value).toContain('"property_count": 4')
          expect(dtb.value).toContain('compatible = \\"turen,fixture\\", \\"turen,dummy\\";')
          expect(dtb.value).toContain("child@0 {")

          const ihex = yield* call("call-ihex-parse", "ihex_parse", { path: "image.hex" })
          expect(ihex.type).toBe("text")
          if (ihex.type !== "text") return
          expect(ihex.value).toContain('"kind": "ihex"')
          expect(ihex.value).toContain('"record_count": 5')
          expect(ihex.value).toContain('"eof": true')
          expect(ihex.value).toContain('"start_address": "0x8000100"')
          expect(ihex.value).toContain('"range_count": 2')

          const flattenedHex = yield* call("call-ihex-flatten", "ihex_flatten", { path: "image.hex" })
          expect(flattenedHex.type).toBe("text")
          if (flattenedHex.type !== "text") return
          expect(flattenedHex.value).toContain("260-byte flattened image")
          const hexImage = yield* Effect.promise(() => artifact(flattenedHex.value))
          expect(hexImage.length).toBe(0x104)
          expect(Array.from(hexImage.subarray(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef])
          expect(Array.from(hexImage.subarray(0x100))).toEqual([1, 2, 3, 4])
          expect(hexImage.subarray(4, 0x100).every((b) => b === 0xff)).toBe(true)

          const srec = yield* call("call-srec-parse", "srec_parse", { path: "image.srec" })
          expect(srec.type).toBe("text")
          if (srec.type !== "text") return
          expect(srec.value).toContain('"kind": "srec"')
          expect(srec.value).toContain('"record_count": 5')
          expect(srec.value).toContain('"header": "HDR"')
          expect(srec.value).toContain('"declared": 2')
          expect(srec.value).toContain('"actual": 2')

          const flattenedSrec = yield* call("call-srec-flatten", "srec_flatten", { path: "image.srec" })
          expect(flattenedSrec.type).toBe("text")
          if (flattenedSrec.type !== "text") return
          const srecImage = yield* Effect.promise(() => artifact(flattenedSrec.value))
          expect(srecImage.length).toBe(0x104)
          expect(Array.from(srecImage.subarray(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef])

          const sparse = yield* call("call-sparse-parse", "android_sparse_parse", { path: "sparse.img" })
          expect(sparse.type).toBe("text")
          if (sparse.type !== "text") return
          expect(sparse.value).toContain('"kind": "android-sparse"')
          expect(sparse.value).toContain('"total_blocks": 4')
          expect(sparse.value).toContain('"expanded_bytes": "16384"')
          expect(sparse.value).toContain('"type": "raw"')
          expect(sparse.value).toContain('"type": "fill"')
          expect(sparse.value).toContain('"type": "dont_care"')
          expect(sparse.value).toContain('"type": "crc32"')
          expect(sparse.value).toContain('"valid": true')

          const expanded = yield* call("call-sparse-expand", "android_sparse_expand", { path: "sparse.img" })
          expect(expanded.type).toBe("text")
          if (expanded.type !== "text") return
          expect(expanded.value).toContain("16384-byte expanded image")
          const image = yield* Effect.promise(() => artifact(expanded.value))
          expect(Buffer.compare(image, Buffer.from(EXPANDED))).toBe(0)

          const failedUimage = yield* call("call-uimage-garbage", "uimage_inspect", { path: "garbage.bin" })
          expect(failedUimage.type).toBe("error")
          const failedHex = yield* call("call-ihex-garbage", "ihex_parse", { path: "garbage.bin" })
          expect(failedHex.type).toBe("error")
          const failedSparse = yield* call("call-sparse-garbage", "android_sparse_parse", { path: "garbage.bin" })
          expect(failedSparse.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
