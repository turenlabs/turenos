import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@turenlabs/core/config"
import { ConfigSemanticMemory } from "@turenlabs/core/config/semantic-memory"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Memory } from "@turenlabs/core/memory"
import { MemorySemantic } from "@turenlabs/core/memory/semantic"
import { Potion, type PotionLoadOptions, type PotionRuntime } from "@turenlabs/plugin/potion"
import { testEffect } from "./lib/effect"

const runtime: PotionRuntime = {
  profile: {
    model: Potion.model,
    revision: Potion.revision,
    dimension: 2,
    dimensions: 2,
    maxTokens: 512,
  },
  embed: (texts) =>
    texts.map((text) => {
      if (text === "unmatched concept" || text.includes("semantic-target")) return new Float32Array([1, 0])
      return new Float32Array([0, 1])
    }),
  close: () => undefined,
}

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            semantic_memory: new ConfigSemanticMemory.Info({ enabled: true, model: "potion-base-8M" }),
          }),
        }),
      ]),
  }),
)

describe("Semantic memory", () => {
  const it = testEffect(Layer.empty)

  it.effect("retries a failed model load and retrieves conceptual matches", () => {
    let attempts = 0
    const load = (_options: PotionLoadOptions) => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(runtime)
    }
    const database = AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node]), [
      [Database.node, Database.layerFromPath(":memory:")],
    ])
    const layer = MemorySemantic.layerWith(load).pipe(Layer.provideMerge(database), Layer.provideMerge(config))

    return Effect.gen(function* () {
      const memory = yield* Memory.Service
      const semantic = yield* MemorySemantic.Service
      const wing = yield* memory.wing({ kind: "project", key: "semantic-test", name: "Semantic test" })
      const room = yield* memory.room({ wingID: wing.id, slug: "general", name: "General" })
      yield* memory.write({
        wingID: wing.id,
        roomID: room.id,
        title: "target",
        body: "semantic-target",
        provenance: { assertedBy: "test", source: "agent" },
      })
      yield* memory.write({
        wingID: wing.id,
        roomID: room.id,
        title: "other",
        body: "semantic-other",
        provenance: { assertedBy: "test", source: "agent" },
      })

      yield* semantic.prepare()
      const results = yield* semantic.search({ query: "unmatched concept", wings: [wing.id], limit: 1 })

      expect(attempts).toBe(2)
      expect(results).toHaveLength(1)
      expect(results[0]?.drawer.title).toBe("target")
    }).pipe(Effect.provide(layer))
  })
})
