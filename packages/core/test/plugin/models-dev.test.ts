import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@turenlabs/core/catalog"
import { Integration } from "@turenlabs/core/integration"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Flag } from "@turenlabs/core/flag/flag"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ModelsDev } from "@turenlabs/core/models-dev"
import { ModelsDevPlugin } from "@turenlabs/core/plugin/models-dev"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventV2.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("projects models.dev modes as separate models instead of variants", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            acme: {
              id: "acme",
              name: "Acme",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  family: "gpt",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  cost: {
                    input: 2.5,
                    output: 15,
                    tiers: [
                      {
                        tier: { type: "context", size: 272_000 },
                        input: 3,
                        output: 18,
                        cache_read: 0.25,
                      },
                    ],
                    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
                  },
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                  experimental: {
                    modes: {
                      fast: {
                        cost: { input: 5, output: 30, cache_read: 0.5 },
                        provider: {
                          headers: { "x-mode": "fast" },
                          body: { service_tier: "priority" },
                        },
                      },
                    },
                  },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const providerID = ProviderV2.ID.make("acme")
      const base = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.request.body).toEqual({})
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        providerID: "acme",
        name: "GPT-5.4 Fast",
        api: { id: "gpt-5.4" },
        request: {
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority" },
        },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        {
          tier: { type: "context", size: 272_000 },
          input: 3,
          output: 18,
          cache: { read: 0.25, write: 0 },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: 5,
          output: 22.5,
          cache: { read: 0.5, write: 0 },
        },
      ])
    }),
  )

  it.effect("projects protocol-specific reasoning efforts onto catalog models", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const openai = {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        models: {
          "gpt-5.6-sol": {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            release_date: "2026-07-09",
            attachment: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
            temperature: false,
            tool_call: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_050_000, input: 922_000, output: 128_000 },
            experimental: {
              modes: { pro: { provider: { body: { reasoning: { mode: "pro" } } } } },
            },
          },
          "compatible-model": {
            id: "compatible-model",
            name: "Compatible model",
            release_date: "2026-07-09",
            attachment: false,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            temperature: true,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
            provider: { npm: "@ai-sdk/openai-compatible" },
          },
        },
      } satisfies ModelsDev.Provider
      const gateway = {
        id: "gateway",
        name: "Gateway",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "native-openai": {
            id: "native-openai",
            name: "Native OpenAI model",
            release_date: "2026-07-09",
            attachment: false,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            temperature: true,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
            provider: { npm: "@ai-sdk/openai" },
          },
          "kimi-k3": {
            id: "kimi-k3",
            name: "Kimi K3",
            release_date: "2026-07-20",
            attachment: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
            temperature: false,
            tool_call: true,
            modalities: { input: ["text", "image", "video"], output: ["text"] },
            limit: { context: 1_048_576, output: 131_072 },
          },
        },
      } satisfies ModelsDev.Provider
      const anthropic = {
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-opus-5": {
            id: "claude-opus-5",
            name: "Claude Opus 5",
            release_date: "2026-06-30",
            attachment: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
            temperature: false,
            tool_call: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_000_000, output: 128_000 },
          },
        },
      } satisfies ModelsDev.Provider
      yield* ModelsDevPlugin.effect(
        host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }),
      ).pipe(
        Effect.provideService(
          ModelsDev.Service,
          ModelsDev.Service.of({
            get: () => Effect.succeed({ openai, gateway, anthropic }),
            refresh: () => Effect.void,
          }),
        ),
      )

      const expected = ["none", "low", "medium", "high", "xhigh", "max"]
      const base = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"))
      const pro = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol-pro"))
      const compatible = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("compatible-model"))
      const native = yield* catalog.model.get(ProviderV2.ID.make("gateway"), ModelV2.ID.make("native-openai"))
      const kimi = yield* catalog.model.get(ProviderV2.ID.make("gateway"), ModelV2.ID.make("kimi-k3"))
      const claude = yield* catalog.model.get(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-opus-5"))
      expect(base?.variants.map((variant) => String(variant.id))).toEqual(expected)
      expect(base?.variants.at(-1)?.body).toEqual({ reasoningEffort: "max" })
      expect(pro?.variants.map((variant) => String(variant.id))).toEqual(expected)
      expect(pro?.request.body).toEqual({ reasoning: { mode: "pro" } })
      expect(compatible?.variants.at(-1)?.body).toEqual({ reasoning_effort: "high" })
      expect(native?.variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
      expect(kimi?.variants.at(-1)?.body).toEqual({ reasoning_effort: "max" })
      expect(claude?.variants.at(-1)?.body).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        effort: "max",
      })
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.FORGE_MODELS_PATH,
          disabled: Flag.FORGE_DISABLE_MODELS_FETCH,
        }
        Flag.FORGE_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.FORGE_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(AppNodeBuilder.build(ModelsDev.node))),
      (previous) =>
        Effect.sync(() => {
          Flag.FORGE_MODELS_PATH = previous.path
          Flag.FORGE_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
