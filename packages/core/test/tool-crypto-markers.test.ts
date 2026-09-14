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
import { CryptoMarkersRuntime } from "@turenlabs/core/tool/crypto-markers-runtime"
import { CryptoMarkersTools } from "@turenlabs/core/tool/crypto-markers-tools"
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

// FIPS-197 AES S-box, 256 bytes starting 63 7c 77 7b f2 6b 6f c5 30 ...
const AES_SBOX_HEX =
  "637c777bf26b6fc5300167" +
  "2bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c3189605" +
  "9a071280e2eb27b27509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaa" +
  "fb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2cd0c13ec5f974417c4a77e3d645d19" +
  "7360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4" +
  "ea657aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e" +
  "949b1e87e9ce5528df8ca1890dbfe6426841" +
  "992d0fb054bb16"

const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)))

describe("CryptoMarkersRuntime and CryptoMarkersTools", () => {
  it.live("profiles and probes fixtures through a fresh crypto-markers worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const sbox = new Uint8Array(512)
          sbox.set([0x4d, 0x5a, 0x90, 0x00], 0)
          sbox.set(fromHex(AES_SBOX_HEX), 100)
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sbox.bin`, sbox))

          const plaintext = new TextEncoder().encode(
            "MZ" + "This is a known plaintext string used for XOR probing tests. ".repeat(4),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/xored.bin`, plaintext.map((byte) => byte ^ 0x42)))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["byte_stats", "crypto_constants", "entropy_map", "xor_probe"])
            expect(names).toContain(name)

          const constants = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_crypto_markers_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-crypto-constants",
              name: "crypto_constants",
              input: { path: "sbox.bin" },
            },
          })
          expect(constants.type).toBe("text")
          if (constants.type !== "text") return
          expect(constants.value).toContain('"schema_version"')
          expect(constants.value).toContain('"algorithm": "aes"')
          expect(constants.value).toContain('"constant_name": "sbox"')

          const entropy = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_crypto_markers_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-entropy-map",
              name: "entropy_map",
              input: { path: "sbox.bin", windowSize: 256 },
            },
          })
          expect(entropy.type).toBe("text")
          if (entropy.type !== "text") return
          expect(entropy.value).toContain('"overall"')
          expect(entropy.value).toContain('"entropy"')
          expect(entropy.value).toContain('"regions"')

          const stats = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_crypto_markers_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-byte-stats",
              name: "byte_stats",
              input: { path: "sbox.bin" },
            },
          })
          expect(stats.type).toBe("text")
          if (stats.type !== "text") return
          expect(stats.value).toContain('"length": 512')
          expect(stats.value).toContain('"unique_bytes"')
          expect(stats.value).toContain('"top_bytes"')

          const xor = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_crypto_markers_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-xor-probe",
              name: "xor_probe",
              input: { path: "xored.bin", crib: "MZ", topK: 3 },
            },
          })
          expect(xor.type).toBe("text")
          if (xor.type !== "text") return
          expect(xor.value).toContain('"candidates"')
          expect(xor.value).toContain('"key": "42"')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                CryptoMarkersRuntime.node,
                CryptoMarkersTools.node,
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
