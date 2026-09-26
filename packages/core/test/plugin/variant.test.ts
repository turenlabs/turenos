import { describe, expect } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { VariantPlugin } from "@turenlabs/core/plugin/variant"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(AppNodeBuilder.build(Catalog.node, [[Location.node, locationLayer]]))

describe("VariantPlugin", () => {
  it.effect("adds GLM 5.2 variants after catalog sources", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* service.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
        })
        catalog.model.update(providerID, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(providerID, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", body: { reasoning_effort: "high" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )

  it.effect("keeps explicit variants over generated defaults", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* service.transform((catalog) => {
        catalog.model.update(providerID, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
          model.variants = [{ id: ModelV2.VariantID.make("high"), headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(providerID, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", headers: { custom: "true" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )

  it.effect("defaults adaptive Claude to high and GPT-5 to medium, and leaves the rest alone", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const effort = (id: string, body: ModelV2.Info["variants"][number]["body"]) => ({
        id: ModelV2.VariantID.make(id),
        headers: {},
        body,
      })
      const add = (id: string, pkg: string, variants: ReturnType<typeof effort>[], variant?: string) =>
        service.transform((catalog) => {
          catalog.model.update(providerID, ModelV2.ID.make(id), (model) => {
            model.api = { id: ModelV2.ID.make(id), type: "aisdk", package: pkg }
            model.variants = variants
            if (variant) model.request.variant = ModelV2.VariantID.make(variant)
          })
        })
      const adaptive = (id: string) => effort(id, { thinking: { type: "adaptive" }, effort: id })
      const openai = (id: string) => effort(id, { reasoningEffort: id })
      yield* add("claude-opus-4-7", "@ai-sdk/anthropic", [adaptive("low"), adaptive("high")])
      yield* add("claude-sonnet-4-5", "@ai-sdk/anthropic", [
        effort("high", { thinking: { type: "enabled", budgetTokens: 16_000 } }),
      ])
      yield* add("claude-opus-4-5", "@ai-sdk/anthropic", [effort("high", { effort: "high" })])
      yield* add("gpt-5.4", "@ai-sdk/openai", [openai("low"), openai("medium")])
      yield* add("gpt-5.4-pro", "@ai-sdk/openai", [openai("medium")])
      yield* add("gpt-5.4-configured", "@ai-sdk/openai", [openai("low"), openai("medium")], "low")
      yield* add("gpt-5.4-no-medium", "@ai-sdk/openai", [openai("low")])
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      const defaultOf = function* (id: string) {
        return (yield* service.model.get(providerID, ModelV2.ID.make(id)))?.request.variant
      }
      expect(yield* defaultOf("claude-opus-4-7")).toBe("high")
      // A fixed 16k thinking budget on every turn is a bigger cost change than adaptive thinking.
      expect(yield* defaultOf("claude-sonnet-4-5")).toBeUndefined()
      expect(yield* defaultOf("claude-opus-4-5")).toBeUndefined()
      expect(yield* defaultOf("gpt-5.4")).toBe("medium")
      expect(yield* defaultOf("gpt-5.4-pro")).toBeUndefined()
      expect(yield* defaultOf("gpt-5.4-configured")).toBe("low")
      expect(yield* defaultOf("gpt-5.4-no-medium")).toBeUndefined()
    }),
  )
})
