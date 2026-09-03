import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { BinaryAnalysisRuntime } from "@turenlabs/core/tool/binary-analysis-runtime"
import { BinaryAnalysisTools } from "@turenlabs/core/tool/binary-analysis-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(AppNodeBuilder.build(BinaryAnalysisRuntime.node))
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

describe("BinaryAnalysisRuntime", () => {
  it.live("executes Goblin, stng-core, and official libpcap WASM", () =>
    Effect.gen(function* () {
      const runtime = yield* BinaryAnalysisRuntime.Service
      const binary = yield* runtime.inspect(minimalElf())
      expect(binary).toMatchObject({ format: "elf", architecture: "x86_64", entryPoint: "0x401000" })

      const strings = yield* runtime.strings({
        bytes: new TextEncoder().encode("https://example.com\0SGVsbG8gd29ybGQh\0"),
        minLength: 4,
        decode: true,
        autoXor: false,
        xorKey: new Uint8Array(),
      })
      expect(strings.strings).toContainEqual(expect.objectContaining({ value: "https://example.com", kind: "url" }))
      expect(strings.strings).toContainEqual(expect.objectContaining({ value: "Hello world!", method: "base64" }))

      const capture = yield* runtime.capture({
        bytes: minimalPcap(),
        filter: "udp and dst port 53",
        offset: 0,
        maxPackets: 4,
        maxPacketBytes: 64,
      })
      expect(capture).toMatchObject({ datalink: 1, datalinkName: "EN10MB", eof: true })
      expect(capture.packets).toHaveLength(1)
      expect(capture.packets[0]?.bytesHex).toStartWith("020000000002")
    }),
  )

  testEffect(Layer.empty).live("registers the four agent-facing tools", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.elf`, minimalElf()))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
            "binary_inspect",
            "extract_strings",
            "pcap_inspect",
            "unpack_static",
          ])
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_binary_analysis_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-binary-inspect",
              name: "binary_inspect",
              input: { path: "sample.elf" },
            },
          })
          expect(result.type).toBe("text")
          if (result.type === "text") expect(result.value).toContain('"format": "elf"')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                BinaryAnalysisRuntime.node,
                BinaryAnalysisTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
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

function minimalElf() {
  const bytes = new Uint8Array(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes[16] = 2
  bytes[18] = 0x3e
  bytes[20] = 1
  new DataView(bytes.buffer).setBigUint64(24, 0x401000n, true)
  bytes[52] = 64
  return bytes
}

function minimalPcap() {
  const packet = Uint8Array.from([
    2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, 8, 0, 0x45, 0, 0, 0x22, 0, 1, 0, 0, 0x40, 0x11, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2,
    0x30, 0x39, 0, 0x35, 0, 10, 0, 0, 0x68, 0x69,
  ])
  const bytes = new Uint8Array(24 + 16 + packet.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xa1b2c3d4, true)
  view.setUint16(4, 2, true)
  view.setUint16(6, 4, true)
  view.setUint32(16, 65535, true)
  view.setUint32(20, 1, true)
  view.setUint32(24, 1700000000, true)
  view.setUint32(32, packet.length, true)
  view.setUint32(36, packet.length, true)
  bytes.set(packet, 40)
  return bytes
}
