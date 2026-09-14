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
import { CapaMatchRuntime } from "@turenlabs/core/tool/capa-match-runtime"
import { CapaMatchTools } from "@turenlabs/core/tool/capa-match-tools"
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
        CapaMatchRuntime.node,
        CapaMatchTools.node,
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

// Ported from tools/capa-match/test/verify.mjs: the file-scope rule
// "contains PDB path" matches a regex over the string table, so a raw buffer
// holding a `:\.*\.pdb` path is enough — no PE structure required.
const PDB_FIXTURE = "junk prefix C:\\build\\agent.pdb junk suffix"

describe("CapaMatchRuntime and CapaMatchTools", () => {
  it.live("matches, extracts, and reports the embedded ruleset through a fresh capa-match worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/pdb.bin`, PDB_FIXTURE))
          // Truncated PE-looking garbage: deep parse paths on malformed input.
          const garbage = new Uint8Array(0x90)
          garbage.set(new TextEncoder().encode("MZ"), 0)
          garbage.set(new Uint8Array([0x40, 0x00, 0x00, 0x00]), 0x3c)
          garbage.set(new TextEncoder().encode("PE"), 0x40)
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.bin`, garbage))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["capa_match", "capa_features", "capa_ruleset"]) expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_capa_match_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const text = (result: { type: string; value: unknown }) => {
            expect(result.type).toBe("text")
            return typeof result.value === "string" ? result.value : String(result.value)
          }

          const ruleset = JSON.parse(text(yield* call("call-capa-ruleset", "capa_ruleset", {}))) as Record<
            string,
            unknown
          >
          expect(ruleset.schema_version).toBe(1)
          expect(ruleset.imported).toBe(true)
          expect(ruleset.rule_count).toBeGreaterThanOrEqual(1000)
          expect(ruleset.commit).toBe("805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5")

          const match = JSON.parse(text(yield* call("call-capa-match", "capa_match", { path: "pdb.bin" }))) as {
            capabilities?: Array<{ name?: string; namespace?: string }>
            capability_count?: number
          }
          const matched = (match.capabilities ?? []).map((capability) => capability.name)
          expect(matched).toContain("contains PDB path")
          expect(
            (match.capabilities ?? []).find((capability) => capability.name === "contains PDB path")?.namespace,
          ).toBe("executable/pe/pdb")
          expect(match.capability_count).toBeGreaterThanOrEqual(1)

          const features = JSON.parse(
            text(yield* call("call-capa-features", "capa_features", { path: "pdb.bin" })),
          ) as {
            formats?: unknown
            strings?: { distinct?: number }
          }
          expect(Array.isArray(features.formats)).toBe(true)
          expect(typeof features.strings?.distinct).toBe("number")
          expect(features.strings?.distinct).toBeGreaterThanOrEqual(1)

          // Malformed input: clean schema-versioned report or clean error — never a crash.
          const malformed = text(yield* call("call-capa-garbage", "capa_match", { path: "garbage.bin" }))
          expect(malformed).toContain('"schema_version"')
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
