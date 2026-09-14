import { describe, expect } from "bun:test"
import { deflateSync } from "node:zlib"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ImageInspectRuntime } from "@turenlabs/core/tool/image-inspect-runtime"
import { ImageInspectTools } from "@turenlabs/core/tool/image-inspect-tools"
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
        ImageInspectRuntime.node,
        ImageInspectTools.node,
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

// Minimal CRC32 (PNG uses the reflected polynomial).
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const u32be = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const encoder = new TextEncoder()
const pngChunk = (type: string, payload: Uint8Array) => {
  const chunk = concat(u32be(payload.length), encoder.encode(type), payload)
  return concat(chunk, u32be(crc32(chunk.subarray(4))))
}

// 2x2 RGB8 PNG: IHDR, one tEXt, one IDAT, IEND.
const pngFixture = () => {
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, 2)
  new DataView(ihdr.buffer).setUint32(4, 2)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const scanlines = concat(
    new Uint8Array([0, 255, 0, 0, 0, 255, 0]),
    new Uint8Array([0, 0, 0, 255, 255, 255, 0]),
  )
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", encoder.encode("Comment\x00hidden payload")),
    pngChunk("IDAT", new Uint8Array(deflateSync(scanlines))),
    pngChunk("IEND", new Uint8Array(0)),
  )
}

describe("ImageInspectRuntime and ImageInspectTools", () => {
  it.live("inspects structure, exif, text chunks, and pixels through a fresh image-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/image.png`, pngFixture()))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/blob.bin`, new Uint8Array([1, 2, 3, 4, 5])))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["image_inspect", "image_exif", "image_pixel_stats", "image_text_chunks"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_image_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspected = yield* call("call-image-inspect", "image_inspect", { path: "image.png" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          expect(typeof inspected.value).toBe("string")
          const inspect = JSON.parse(String(inspected.value)) as {
            format?: string
            width?: number
            height?: number
            chunks?: Array<{ name: string }>
            text_chunks?: Array<{ keyword: string; text: string }>
          }
          expect(inspect.format).toBe("png")
          expect(inspect.width).toBe(2)
          expect(inspect.height).toBe(2)
          expect(inspect.chunks?.map((chunk) => chunk.name)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"])
          expect(inspect.text_chunks?.[0]?.text).toBe("hidden payload")

          const exif = yield* call("call-image-exif", "image_exif", { path: "image.png" })
          expect(exif.type).toBe("text")
          if (exif.type !== "text") return
          expect(exif.value).toContain('"exif_present": false')
          expect(exif.value).toContain('"format": "png"')

          const texts = yield* call("call-image-text-chunks", "image_text_chunks", { path: "image.png" })
          expect(texts.type).toBe("text")
          if (texts.type !== "text") return
          const chunks = JSON.parse(String(texts.value)) as {
            entries?: Array<{ location: string; keyword: string; text: string }>
          }
          expect(chunks.entries?.[0]?.location).toBe("png:tEXt")
          expect(chunks.entries?.[0]?.keyword).toBe("Comment")
          expect(chunks.entries?.[0]?.text).toBe("hidden payload")

          const stats = yield* call("call-image-pixel-stats", "image_pixel_stats", { path: "image.png" })
          expect(stats.type).toBe("text")
          if (stats.type !== "text") return
          const pixels = JSON.parse(String(stats.value)) as {
            decoded?: boolean
            luma_histogram?: number[]
            sampled_pixels?: number
          }
          expect(pixels.decoded).toBe(true)
          expect(pixels.luma_histogram?.length).toBe(16)
          expect(pixels.luma_histogram?.reduce((a, b) => a + b, 0)).toBe(pixels.sampled_pixels)

          const failed = yield* call("call-image-inspect-bad", "image_inspect", { path: "blob.bin" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
