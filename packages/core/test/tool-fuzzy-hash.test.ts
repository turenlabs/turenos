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
import { FuzzyHashRuntime } from "@turenlabs/core/tool/fuzzy-hash-runtime"
import { FuzzyHashTools } from "@turenlabs/core/tool/fuzzy-hash-tools"
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

describe("FuzzyHashRuntime and FuzzyHashTools", () => {
  it.live("hashes and compares digests through a fresh fuzzy-hash worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const input = new Uint8Array(8192)
          for (let i = 0; i < input.length; i++) input[i] = (i * 31 + 7) % 251
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sample.bin`, input))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["hash_all", "fuzzy_hash", "fuzzy_compare"]) expect(names).toContain(name)

          const all = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_fuzzy_hash_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-hash-all",
              name: "hash_all",
              input: { path: "sample.bin" },
            },
          })
          expect(all.type).toBe("text")
          if (all.type !== "text") return
          expect(all.value).toContain('"schema_version"')
          expect(all.value).toContain('"sha256"')
          expect(all.value).toContain('"md5"')
          expect(all.value).toContain('"imphash": null')

          const fuzzy = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_fuzzy_hash_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-fuzzy-hash",
              name: "fuzzy_hash",
              input: { path: "sample.bin", algorithm: "ssdeep" },
            },
          })
          expect(fuzzy.type).toBe("text")
          if (fuzzy.type !== "text") return
          expect(fuzzy.value).toContain('"algorithm": "ssdeep"')
          expect(fuzzy.value).toContain('"hash"')
          const digest = (JSON.parse(String(fuzzy.value)) as { hash?: string }).hash
          expect(digest).toBeTruthy()

          const tlsh = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_fuzzy_hash_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-fuzzy-hash-tlsh",
              name: "fuzzy_hash",
              input: { path: "sample.bin", algorithm: "tlsh" },
            },
          })
          expect(tlsh.type).toBe("text")
          if (tlsh.type !== "text") return
          expect(tlsh.value).toContain('"algorithm": "tlsh"')
          expect(tlsh.value).toContain('"hash": "T1')

          const compare = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_fuzzy_hash_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-fuzzy-compare",
              name: "fuzzy_compare",
              input: { algorithm: "ssdeep", hashA: digest, hashB: digest },
            },
          })
          expect(compare.type).toBe("text")
          if (compare.type !== "text") return
          expect(compare.value).toContain('"algorithm": "ssdeep"')
          expect(compare.value).toContain('"score": 100')
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                FuzzyHashRuntime.node,
                FuzzyHashTools.node,
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
