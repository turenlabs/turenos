import { describe, expect } from "bun:test"
import { Exit, Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ProtocolInspectRuntime } from "@turenlabs/core/tool/protocol-inspect-runtime"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(ProtocolInspectRuntime.node))

describe("ProtocolInspectRuntime", () => {
  it.effect("rejects packet bytes above the worker input bound", () =>
    Effect.gen(function* () {
      const runtime = yield* ProtocolInspectRuntime.Service
      const result = yield* runtime
        .inspect({ bytes: new Uint8Array(ProtocolInspectRuntime.MAX_PACKET_BYTES + 1), linkType: 1 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  )

  it.live("parses a selected Ethernet packet through the bundled WASM runtime", () =>
    Effect.gen(function* () {
      const runtime = yield* ProtocolInspectRuntime.Service
      const result = yield* runtime.inspect({ bytes: ethernetPacket(), linkType: 1 })
      expect(result).toBeInstanceOf(Object)
      expect(result).not.toHaveProperty("error")
    }),
  )
})

function ethernetPacket() {
  return Uint8Array.from([
    2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, 8, 0, 0x45, 0, 0, 0x1e, 0, 1, 0, 0, 0, 0x40, 0x11, 0, 0,
    10, 0, 0, 1, 10, 0, 0, 2, 0x30, 0x39, 0, 53, 0, 10, 0, 0, 0x68, 0x69,
  ])
}
