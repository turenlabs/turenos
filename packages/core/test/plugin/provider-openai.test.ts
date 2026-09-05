import { AISDK } from "@turenlabs/core/aisdk"
import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Catalog } from "@turenlabs/core/catalog"
import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/core/integration"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { OpenAIPlugin } from "@turenlabs/core/plugin/provider/openai"
import { OpenAICodex } from "@turenlabs/core/plugin/provider/openai-codex"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { LLM } from "@turenlabs/llm"
import { LLMClient } from "@turenlabs/llm/route"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  const integrations = yield* Integration.Service
  yield* OpenAIPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integrations))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

describe("OpenAIPlugin", () => {
  it.effect("offers the Astra fallback through API-key and ChatGPT OAuth Responses routes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const model = required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-astra")))

      expect(model).toMatchObject({
        name: "GPT-6 Astra",
        api: { id: "gpt-6-astra", type: "aisdk", package: "@ai-sdk/openai" },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
        status: "active",
        enabled: true,
      })
      expect(model.cost).toEqual([
        { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
        { tier: { type: "context", size: 272_000 }, input: 20, output: 75, cache: { read: 2, write: 25 } },
      ])
      expect(model.variants.map((variant) => [variant.id, variant.body.reasoningEffort])).toEqual([
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
      ])
      yield* aisdk.runLanguage({ model, sdk: fakeSelectorSdk(calls), options: {} })
      expect(calls).toEqual(["responses:gpt-6-astra"])

      for (const credential of [
        Credential.Key.make({ type: "key", key: "test-key" }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "test-account" },
        }),
      ]) {
        expect(SessionRunnerModel.selectableWithCredential(model, credential)).toBe(true)
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(model, credential)
        const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))
        expect(resolved.route.id).toBe("openai-responses")
        expect(resolved.route.defaults?.limits).toMatchObject(model.limit)
        expect(resolved.route.endpoint.baseURL).toBe(
          credential.type === "oauth" ? OpenAICodex.API_ENDPOINT : "https://api.openai.com/v1",
        )
        expect(prepared.body).toMatchObject({
          model: "gpt-6-astra",
          store: false,
          include: ["reasoning.encrypted_content"],
        })
      }
      expect(OpenAICodex.eligible("gpt-6-astra", "pro")).toBe(false)
    }),
  )

  it.effect("preserves upstream Astra metadata and explicit request options", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(ProviderV2.ID.openai, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        draft.model.update(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-astra"), (model) => {
          model.name = "Upstream Astra"
          model.limit = { context: 2_000_000, output: 256_000 }
          model.cost = [{ input: 3, output: 9, cache: { read: 0.3, write: 0 } }]
          model.variants = [{ id: ModelV2.VariantID.make("high"), headers: {}, body: { reasoningEffort: "high" } }]
          model.request.body = { include: [], reasoningSummary: "auto" }
          model.enabled = false
          model.time.released = 123
        })
      })
      const upstream = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-astra"))
      yield* addPlugin()
      expect(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-astra"))).toEqual(upstream)
    }),
  )

  it.effect("maps Daybreak API IDs to Codex model IDs", () =>
    Effect.sync(() => {
      expect(OpenAICodex.eligible("daybreak-blue-latest")).toBe(true)
      expect(OpenAICodex.eligible("daybreak-red-latest")).toBe(true)
      expect(OpenAICodex.eligible("gpt-5.6-cyber")).toBe(true)
      expect(OpenAICodex.codexModelID("daybreak-blue-latest")).toBe("gpt-daybreak-blue-latest")
      expect(OpenAICodex.codexModelID("daybreak-red-latest")).toBe("gpt-daybreak-red-latest")
      expect(OpenAICodex.codexModelID("gpt-5.6-cyber")).toBe("gpt-5.6-cyber")

      const projected = OpenAICodex.projectRequest({
        request: "https://api.openai.com/v1/responses",
        init: { body: JSON.stringify({ model: "daybreak-blue-latest", input: [] }) },
        access: "access-token",
      })
      expect(JSON.parse(projected.init.body as string).model).toBe("gpt-daybreak-blue-latest")
    }),
  )

  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.effect("creates an OpenAI SDK for @ai-sdk/openai using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai",
        options: { name: "custom-openai", apiKey: "test" },
      })
      expect(result.sdk?.responses("gpt-5").provider).toBe("custom-openai.responses")
    }),
  )

  it.effect("ignores non-OpenAI SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openai" },
      })
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses the Responses API for language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("alias")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual(["responses:gpt-5"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("registers Daybreak and Cyber models with the OpenAI Responses route", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()

      expect(yield* catalog.provider.get(ProviderV2.ID.openai)).toMatchObject({
        name: "OpenAI",
        api: { type: "aisdk", package: "@ai-sdk/openai" },
      })

      const expected = {
        "daybreak-blue-latest": {
          name: "Daybreak Blue",
          limit: { context: 1_050_000, input: 922_000, output: 128_000 },
          cost: [
            { input: 5, output: 30, cache: { read: 0.5, write: 6.25 } },
            {
              tier: { type: "context", size: 272_000 },
              input: 10,
              output: 45,
              cache: { read: 1, write: 12.5 },
            },
          ],
        },
        "daybreak-red-latest": {
          name: "Daybreak Red",
          limit: { context: 400_000, input: 272_000, output: 128_000 },
          cost: [{ input: 12.5, output: 75, cache: { read: 1.25, write: 15.625 } }],
        },
        "gpt-5.6-cyber": {
          name: "GPT-5.6 Cyber",
          limit: { context: 400_000, input: 272_000, output: 128_000 },
          cost: [{ input: 12.5, output: 75, cache: { read: 1.25, write: 15.625 } }],
        },
      }

      for (const [id, details] of Object.entries(expected)) {
        const model = required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make(id)))
        expect(model).toMatchObject({
          id,
          name: details.name,
          api: { id, type: "aisdk", package: "@ai-sdk/openai" },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: ["none", "low", "medium", "high", "xhigh", "max"].map((effort) => ({
            id: effort,
            body: { reasoningEffort: effort },
          })),
          cost: details.cost,
          status: "active",
          enabled: true,
          limit: details.limit,
        })
        yield* aisdk.runLanguage({ model, sdk: fakeSelectorSdk(calls), options: {} })
      }

      expect(calls).toEqual([
        "responses:daybreak-blue-latest",
        "responses:daybreak-red-latest",
        "responses:gpt-5.6-cyber",
      ])
    }),
  )

  it.effect("ignores non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.anthropic, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )

  it.effect("disables the retired chat alias and Realtime models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          api: { type: "aisdk", package: "@ai-sdk/openai" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5.6-sol"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-5.6-sol")
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-realtime-2.1"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-realtime-2.1")
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-4o-realtime-preview"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-4o-realtime-preview")
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-5-chat-latest")
        })
      })
      yield* addPlugin()
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"))).enabled).toBe(
        true,
      )
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-realtime-2.1"))).enabled,
      ).toBe(false)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-4o-realtime-preview"))).enabled,
      ).toBe(false)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-chat-latest"))).enabled,
      ).toBe(false)
    }),
  )

  it.effect("does not disable Realtime-shaped IDs for non-OpenAI providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.make("custom-openai")),
          api: { type: "aisdk", package: "test-provider" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-realtime-2.1"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-realtime-2.1")
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-4o-realtime-preview"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-4o-realtime-preview")
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), (model) => {
          model.api.id = ModelV2.ID.make("gpt-5-chat-latest")
        })
      })
      yield* addPlugin()
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-realtime-2.1")))
          .enabled,
      ).toBe(true)
      expect(
        required(
          yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-4o-realtime-preview")),
        ).enabled,
      ).toBe(true)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(true)
    }),
  )
})
