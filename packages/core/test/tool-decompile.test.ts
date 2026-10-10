import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { Effect, Fiber, Layer, Option } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { DecompileTool } from "@turenlabs/core/tool/decompile"
import { DecompilerRuntime } from "@turenlabs/core/tool/decompiler-runtime"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
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

const add = {
  bytes: Uint8Array.from(Buffer.from("554889e5897dfc8975f88b45fc0345f85dc3", "hex")),
  architecture: "x86_64",
  endianness: "little",
  baseAddress: 0x1000,
  address: 0x1000,
} satisfies DecompilerRuntime.Input

// Worker thread IDs are process-wide and increase by one per thread, so the difference between two
// probes counts the threads started in between, including the probe itself.
function nextThreadID() {
  const probe = new Worker("", { eval: true })
  void probe.terminate()
  return probe.threadId
}

describe("DecompileTool", () => {
  it.live("decompiles x86-64 bytes through the bundled WebAssembly runtime", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(`${tmp.path}/add.bin`, Buffer.from("554889e5897dfc8975f88b45fc0345f85dc3", "hex")),
          )
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["decompile"])
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_decompile_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-decompile",
              name: "decompile",
              input: { path: "add.bin", address: 0x1000, baseAddress: 0x1000, architecture: "x86_64" },
            },
          })
          expect(result.type).toBe("text")
          if (result.type !== "text") return
          expect(result.value).toContain("x86_64 @ 0x1000")
          expect(result.value).toContain("return param_1 + param_2")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                DecompilerRuntime.node,
                DecompileTool.node,
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

  it.live("keeps the event loop responsive during a large decompile", () =>
    Effect.gen(function* () {
      const decompiler = yield* DecompilerRuntime.Service
      const bytes = new Uint8Array(2 * 1024 * 1024)
      bytes.fill(0x90)
      bytes[bytes.length - 1] = 0xc3
      const running = yield* decompiler
        .decompile({
          bytes,
          architecture: "x86_64",
          endianness: "little",
          baseAddress: 0,
          address: 0,
        })
        .pipe(Effect.forkChild)
      const completed = yield* Fiber.await(running).pipe(Effect.timeoutOption("20 millis"))
      expect(Option.isNone(completed)).toBe(true)
      yield* Fiber.interrupt(running)

      const retry = yield* decompiler.decompile({
        bytes: Uint8Array.from(Buffer.from("554889e5897dfc8975f88b45fc0345f85dc3", "hex")),
        architecture: "x86_64",
        endianness: "little",
        baseAddress: 0x1000,
        address: 0x1000,
      })
      expect(retry).toContain("return param_1 + param_2")
    }).pipe(Effect.provide(AppNodeBuilder.build(DecompilerRuntime.node))),
  )

  it.live("keeps a queued decompile independent when the running request is interrupted", () =>
    Effect.gen(function* () {
      const decompiler = yield* DecompilerRuntime.Service
      const bytes = new Uint8Array(2 * 1024 * 1024)
      bytes.fill(0x90)
      bytes[bytes.length - 1] = 0xc3
      const running = yield* decompiler
        .decompile({ bytes, architecture: "x86_64", endianness: "little", baseAddress: 0, address: 0 })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      const queued = yield* decompiler
        .decompile({
          bytes: Uint8Array.from(Buffer.from("554889e5897dfc8975f88b45fc0345f85dc3", "hex")),
          architecture: "x86_64",
          endianness: "little",
          baseAddress: 0x1000,
          address: 0x1000,
        })
        .pipe(Effect.forkChild)

      yield* Fiber.interrupt(running)
      expect(yield* Fiber.join(queued)).toContain("return param_1 + param_2")
    }).pipe(Effect.provide(AppNodeBuilder.build(DecompilerRuntime.node))),
  )

  it.live("starts a fresh worker after a failed request", () =>
    Effect.gen(function* () {
      const decompiler = yield* DecompilerRuntime.Service
      const before = nextThreadID()
      // The worker cannot encode a request without an address, so it reports a failure.
      const failure = yield* decompiler.decompile(Object.assign({}, add, { address: undefined })).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Error)
      expect(yield* decompiler.decompile(add)).toContain("return param_1 + param_2")
      // Two probes plus the replacement worker; a worker another test starts meanwhile only adds to it.
      expect(nextThreadID() - before).toBeGreaterThanOrEqual(3)
    }).pipe(Effect.provide(AppNodeBuilder.build(DecompilerRuntime.node))),
  )

  // Relies on the checked-in module growing its heap on every call; revisit once that leak is fixed.
  it.live(
    "starts a fresh worker once the wasm heap passes its limit",
    () =>
      Effect.gen(function* () {
        const decompiler = yield* DecompilerRuntime.Service
        const before = nextThreadID()
        for (let request = 1; request <= 40; request++) {
          expect(yield* decompiler.decompile(add)).toContain("return param_1 + param_2")
          // One thread per probe plus the first worker; anything more is a replacement worker.
          if (nextThreadID() - before > request + 1) return
        }
        expect.unreachable("the decompiler worker was never replaced")
      }).pipe(Effect.provide(AppNodeBuilder.build(DecompilerRuntime.node))),
    30_000,
  )
})
