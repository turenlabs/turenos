import { createHash } from "node:crypto"
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
import { CodecRuntime } from "@turenlabs/core/tool/codec-runtime"
import { CodecTools } from "@turenlabs/core/tool/codec-tools"
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
        CodecRuntime.node,
        CodecTools.node,
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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("CodecRuntime and CodecTools", () => {
  it.live("compresses, decompresses, encodes, decodes, and detects through a fresh codec worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const raw = new Uint8Array(1024)
          for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) % 256
          yield* Effect.promise(() => Bun.write(`${tmp.path}/raw.bin`, raw))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.bin`, "definitely not a gzip stream"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["codec_compress", "codec_decompress", "codec_detect", "codec_encode", "codec_decode"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_codec_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })
          const artifact = (value: unknown) =>
            typeof value === "string" ? / to (\S+) \(sha256/.exec(value)?.[1] : undefined

          const compressed = yield* call("call-codec-compress", "codec_compress", {
            path: "raw.bin",
            algorithm: "gzip",
          })
          expect(compressed.type).toBe("text")
          if (compressed.type !== "text") return
          expect(compressed.value).toContain("sha256")
          const compressedPath = artifact(compressed.value)
          expect(compressedPath).toBeTruthy()

          const detected = yield* call("call-codec-detect", "codec_detect", { path: compressedPath! })
          expect(detected.type).toBe("text")
          if (detected.type !== "text") return
          expect(detected.value).toContain('"schema_version"')
          expect(detected.value).toContain('"primary": "gzip"')

          const decompressed = yield* call("call-codec-decompress", "codec_decompress", {
            path: compressedPath!,
            algorithm: "gzip",
          })
          expect(decompressed.type).toBe("text")
          if (decompressed.type !== "text") return
          expect(decompressed.value).toContain(sha256(raw))
          const decompressedPath = artifact(decompressed.value)
          expect(decompressedPath).toBeTruthy()
          expect(new Uint8Array(yield* Effect.promise(() => fs.readFile(decompressedPath!)))).toEqual(raw)

          const encoded = yield* call("call-codec-encode", "codec_encode", {
            path: "raw.bin",
            encoding: "base64",
          })
          expect(encoded.type).toBe("text")
          if (encoded.type !== "text") return
          const encodedPath = artifact(encoded.value)
          expect(encodedPath).toBeTruthy()
          const encodedText = yield* Effect.promise(() => fs.readFile(encodedPath!, "utf8"))
          expect(encodedText).toBe(Buffer.from(raw).toString("base64"))

          const decoded = yield* call("call-codec-decode", "codec_decode", {
            path: encodedPath!,
            encoding: "base64",
          })
          expect(decoded.type).toBe("text")
          if (decoded.type !== "text") return
          expect(decoded.value).toContain(sha256(raw))

          const failed = yield* call("call-codec-decompress-garbage", "codec_decompress", {
            path: "garbage.bin",
            algorithm: "gzip",
          })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
