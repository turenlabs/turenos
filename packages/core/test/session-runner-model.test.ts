import { describe, expect, test } from "bun:test"
import { LLM } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Headers, HttpClientResponse } from "effect/unstable/http"
import { AISDK } from "@turenlabs/core/aisdk"
import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/core/integration"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ProjectV2 } from "@turenlabs/core/project"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionV2 } from "@turenlabs/core/session"
import { AbsolutePath } from "@turenlabs/core/schema"
import { it } from "./lib/effect"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
    },
    variants,
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

describe("SessionRunnerModel", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
    }),
  )

  it.effect("adds TurenOS identity and OpenCode session affinity to resolved routes", () =>
    Effect.gen(function* () {
      const catalog = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/go/v1" }),
        id: ModelV2.ID.make("opencode-go/deepseek-v4-flash"),
        providerID: ProviderV2.ID.make("opencode-go"),
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_opencode_route"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.headers).toMatchObject({
        "User-Agent": `TurenOS/${InstallationVersion}`,
        "x-opencode-session": session.id,
      })

      const requests: Array<{ readonly headers: Record<string, string> }> = []
      const executor = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (request) => {
            requests.push({ headers: request.headers })
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  [
                    'data: {"id":"chatcmpl_test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
                    "",
                    'data: {"id":"chatcmpl_test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                    "",
                    "data: [DONE]",
                    "",
                  ].join("\n"),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            )
          },
        }),
      )
      yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
        Stream.runCollect,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(executor))),
      )

      expect(requests[0]?.headers).toMatchObject({
        "user-agent": `TurenOS/${InstallationVersion}`,
        "x-opencode-session": session.id,
      })
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("preserves GPT-5.6 reasoning mode and context from catalog request defaults", () =>
    Effect.gen(function* () {
      const catalog = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        request: {
          headers: {},
          body: { reasoning: { effort: "max", mode: "pro", context: "all_turns" } },
        },
      })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(prepared.body).toMatchObject({
        reasoning: { effort: "max", mode: "pro", context: "all_turns" },
      })
    }),
  )

  it.effect("normalizes snake-case reasoning controls without retaining unsupported root fields", () =>
    Effect.gen(function* () {
      const catalog = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        request: {
          headers: {},
          body: { reasoning_mode: "pro", reasoning_context: "all_turns" },
        },
      })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(prepared.body).toMatchObject({ reasoning: { mode: "pro", context: "all_turns" } })
      expect(prepared.body).not.toHaveProperty("reasoning_mode")
      expect(prepared.body).not.toHaveProperty("reasoning_context")
    }),
  )

  it.effect("applies Moonshot tool-schema compatibility to both Kimi transports", () =>
    Effect.gen(function* () {
      const openai = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.moonshot.ai/v1" }),
          providerID: ProviderV2.ID.make("moonshotai"),
          api: {
            id: ModelV2.ID.make("kimi-k3"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://api.moonshot.ai/v1",
          },
        }),
      )
      const anthropic = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://api.kimi.com/coding/v1" }),
          providerID: ProviderV2.ID.make("kimi-for-coding"),
          api: {
            id: ModelV2.ID.make("k3"),
            type: "aisdk",
            package: "@ai-sdk/anthropic",
            url: "https://api.kimi.com/coding/v1",
          },
        }),
      )

      expect(openai.compatibility?.toolSchema).toBe("moonshot")
      expect(anthropic.compatibility?.toolSchema).toBe("moonshot")
    }),
  )

  it.effect("carries interleaved reasoning_content through as passback compatibility", () =>
    Effect.gen(function* () {
      const base = model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/v1" })
      const interleaved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...base,
          capabilities: { ...base.capabilities, interleaved: { field: "reasoning_content" } },
        }),
      )
      const plain = yield* SessionRunnerModel.fromCatalogModel(ModelV2.Info.make(base))

      expect(interleaved.compatibility?.reasoningPassback).toBe(true)
      // A text-only catalog resolves as text-only on OpenAI-protocol routes, not "no opinion".
      expect(interleaved.compatibility?.mediaInput).toBe(false)
      expect(plain.compatibility?.mediaInput).toBe(false)
    }),
  )

  it.effect("keeps images off OpenAI-protocol routes unless the catalog claims image input", () =>
    Effect.gen(function* () {
      const base = model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/v1" })
      const silent = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({ ...base, capabilities: { ...base.capabilities, input: [] } }),
      )
      const vision = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({ ...base, capabilities: { ...base.capabilities, input: ["image", "text"] } }),
      )

      // Empty modalities are text-only: a text-only upstream rejects the whole request on an image
      // part, and the attachment stays in the transcript so every retry fails identically.
      expect(silent.compatibility?.mediaInput).toBe(false)
      // The one case media stays on: the catalog explicitly declares image input.
      expect(vision.compatibility?.mediaInput).toBe(undefined)
    }),
  )

  it.effect("applies text-only mediaInput on every OpenAI-protocol adapter and the bridge", () =>
    Effect.gen(function* () {
      const packages = [
        { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" },
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://opencode.ai/zen/v1" },
        { type: "aisdk", package: "@ai-sdk/azure", url: "https://res.openai.azure.com/openai/v1" },
        { type: "aisdk", package: "@ai-sdk/xai", url: "https://api.x.ai/v1" },
        { type: "aisdk", package: "@openrouter/ai-sdk-provider", url: "https://openrouter.ai/api/v1" },
      ] as const
      for (const api of packages) {
        const resolved = yield* SessionRunnerModel.fromCatalogModel(model(api))
        expect(resolved.compatibility?.mediaInput, api.package).toBe(false)
      }
    }),
  )

  it.effect("rejects OAuth-only Codex Spark for API-key resolution", () =>
    Effect.gen(function* () {
      const catalog = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/openai" }),
        id: ModelV2.ID.make("gpt-5.3-codex-spark"),
        providerID: ProviderV2.ID.openai,
        api: { id: ModelV2.ID.make("gpt-5.3-codex-spark"), type: "aisdk", package: "@ai-sdk/openai" },
      })
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        catalog,
        Credential.Key.make({ type: "key", key: "secret" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ProviderConfigurationError",
        modelID: "gpt-5.3-codex-spark",
      })
      expect(
        SessionRunnerModel.selectableWithCredential(catalog, Credential.Key.make({ type: "key", key: "secret" })),
      ).toBe(false)
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("overlays selected OpenAI Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {
            store: false,
            service_tier: "priority",
            temperature: 0.2,
            reasoning: { effort: "high" },
          },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.generation).toMatchObject({ temperature: 0.2 })
      expect(resolved.route.defaults.providerOptions).toEqual({
        openai: {
          store: false,
          reasoningEffort: "high",
          serviceTier: "priority",
        },
      })
      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        temperature: 0.2,
        store: false,
        service_tier: "priority",
        reasoning: { effort: "high" },
      })
      expect(resolved.route.defaults.http?.body).not.toHaveProperty("temperature")
    }),
  )

  it.effect("overlays selected OpenAI-compatible Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("captures an implicit catalog variant in the resolved durable model reference", () =>
    Effect.gen(function* () {
      const firstVariant = ModelV2.VariantID.make("variant-1")
      const secondVariant = ModelV2.VariantID.make("variant-2")
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        { id: firstVariant, headers: {}, body: { temperature: 0.1 } },
        { id: secondVariant, headers: {}, body: { temperature: 0.2 } },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_implicit_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })
      const first = yield* SessionRunnerModel.resolveWithRef(
        session,
        ModelV2.Info.make({ ...catalog, request: { ...catalog.request, variant: firstVariant } }),
      )
      const second = yield* SessionRunnerModel.resolveWithRef(
        session,
        ModelV2.Info.make({ ...catalog, request: { ...catalog.request, variant: secondVariant } }),
      )

      expect(first.ref).toEqual({
        id: catalog.id,
        providerID: catalog.providerID,
        variant: firstVariant,
      })
      expect(second.ref.variant).toBe(secondVariant)
      expect(first.ref.variant).toBe(firstVariant)
    }),
  )

  // A session's variant outlives the model it was chosen for, so a stored id that this
  // model never published is stale state rather than a request to honour. Resolution must
  // degrade to the model's default instead of stranding every future turn in the session.
  it.effect("falls back to the model default when the stored Session variant is unavailable", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_unavailable"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolveWithRef(session, catalog)

      // No variant was applied, so the durable reference must not claim one.
      expect(resolved.ref.variant).toBeUndefined()
      expect(resolved.ref.id).toBe(catalog.id)
      expect(resolved.ref.providerID).toBe(catalog.providerID)
    }),
  )

  // An unavailable id must not suppress the variant the catalog itself marks as default.
  it.effect("still applies the catalog default when the stored Session variant is unavailable", () =>
    Effect.gen(function* () {
      const fallback = ModelV2.VariantID.make("catalog-default")
      const base = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        { id: fallback, headers: { "x-variant": "fallback" }, body: {} },
      ])
      const catalog = ModelV2.Info.make({ ...base, request: { ...base.request, variant: fallback } })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_fallback"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolveWithRef(session, catalog)

      expect(resolved.ref.variant).toBe(fallback)
    }),
  )

  // Background calls (titles, compaction) cap output far below a turn, so the model's default
  // reasoning level must not follow them there. A level the session chose still does.
  it.effect("skips the catalog default only when asked, and never a selected variant", () =>
    Effect.gen(function* () {
      const fallback = ModelV2.VariantID.make("medium")
      const selected = ModelV2.VariantID.make("low")
      const base = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        { id: selected, headers: {}, body: { reasoningEffort: "low" } },
        { id: fallback, headers: {}, body: { reasoningEffort: "medium" } },
      ])
      const catalog = ModelV2.Info.make({ ...base, request: { ...base.request, variant: fallback } })
      const session = (variant?: ModelV2.VariantID) =>
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_model_variant_background"),
          projectID: ProjectV2.ID.global,
          title: "test",
          model: { id: catalog.id, providerID: catalog.providerID, ...(variant ? { variant } : {}) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/project") },
        })
      const background = { defaultVariant: false }

      expect((yield* SessionRunnerModel.resolveWithRef(session(), catalog)).ref.variant).toBe(fallback)
      expect(
        (yield* SessionRunnerModel.resolveWithRef(session(), catalog, undefined, undefined, background)).ref.variant,
      ).toBeUndefined()
      expect(
        (yield* SessionRunnerModel.resolveWithRef(
          session(ModelV2.VariantID.make("default")),
          catalog,
          undefined,
          undefined,
          background,
        )).ref.variant,
      ).toBeUndefined()
      expect(
        (yield* SessionRunnerModel.resolveWithRef(session(selected), catalog, undefined, undefined, background)).ref
          .variant,
      ).toBe(selected)
    }),
  )

  it.effect("overlays selected Anthropic Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: { thinking: { type: "enabled", budget_tokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      // The shared fixture caps output at 20 tokens; Anthropic needs max_tokens above the budget.
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({ model: resolved, prompt: "Hello", generation: { maxTokens: 32_000 } }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(resolved.route.defaults.providerOptions).toEqual({
        anthropic: { thinking: { type: "enabled", budget_tokens: 12000 } },
      })
      expect(prepared.body).toMatchObject({ thinking: { type: "enabled", budget_tokens: 12000 } })
    }),
  )

  // Compaction and titles cap output far below a budget-based variant; that used to send an
  // invalid budget_tokens >= max_tokens request that Anthropic rejects.
  it.effect("drops a selected thinking budget on calls whose output cap cannot hold it", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: { thinking: { type: "enabled", budgetTokens: 16_000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_budget"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({ model: resolved, prompt: "Summarise", generation: { maxTokens: 4_096 } }),
      )

      expect(prepared.body.max_tokens).toBe(4_096)
      expect(prepared.body.thinking).toBeUndefined()
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("rejects routed provider/package pairs without a qualified endpoint before credential projection", () =>
    Effect.gen(function* () {
      const routed = ModelV2.Info.make({
        ...model({ type: "aisdk", package: "@ai-sdk/anthropic" }),
        providerID: ProviderV2.ID.make("cloudflare-ai-gateway"),
        request: { headers: {}, body: {} },
      })
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        routed,
        Credential.Key.make({
          type: "key",
          key: "cloudflare-secret",
          metadata: { accountId: "account", gatewayId: "gateway", baseURL: "https://metadata.example/v1" },
        }),
      ).pipe(Effect.flip)
      const remapped = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...routed,
          api: {
            id: routed.api.id,
            type: "aisdk",
            package: "@ai-sdk/anthropic",
            url: "https://api.anthropic.com/v1",
          },
        }),
        Credential.Key.make({ type: "key", key: "cloudflare-secret" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "cloudflare-ai-gateway",
        api: "aisdk:@ai-sdk/anthropic",
      })
      expect(remapped._tag).toBe("SessionRunnerModel.UnsupportedApiError")
      expect(SessionRunnerModel.supported(routed)).toBe(false)
    }),
  )

  it.effect("rejects public plaintext endpoints but accepts private LAN addresses", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://provider.example/v1" }),
        Credential.Key.make({ type: "key", key: "secret" }),
      ).pipe(Effect.flip)

      expect(failure._tag).toBe("SessionRunnerModel.UnsupportedApiError")
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://192.168.66.171:11435/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://1e1.0.0.1e1/v1" }),
        ),
      ).toBe(false)
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret", metadata: { tenant: "work" } })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" } },
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
      expect(
        JSON.stringify((yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))).body),
      ).not.toContain("tenant")
    }),
  )

  it.effect("fails closed instead of sending ChatGPT OAuth to a public OpenAI-compatible route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://api.openai.com/v1" }),
          providerID: ProviderV2.ID.openai,
          request: { headers: {}, body: {} },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.ProviderConfigurationError",
        reason: "ChatGPT OAuth cannot be sent to the public OpenAI API",
      })
    }),
  )

  it.effect("streams eligible ChatGPT OAuth models through the shared Codex route and account header", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
      const executor = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (request) => {
            requests.push({ url: request.url, headers: request.headers })
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  [
                    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Codex ready."}',
                    "",
                    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
                    "",
                  ].join("\n"),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            )
          },
        }),
      )
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai" })
      const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
        ModelV2.Info.make({
          ...catalog,
          providerID: ProviderV2.ID.openai,
          api: { ...catalog.api, id: ModelV2.ID.make("gpt-5.3-codex-spark") },
          request: { headers: {}, body: { store: false } },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
          metadata: { accountID: "acct_123", tenant: "must-not-project" },
        }),
      ).pipe(Effect.provide(AISDK.locationLayer))
      const events = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Hello." })).pipe(
        Stream.runCollect,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(executor))),
      )

      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://chatgpt.com/backend-api/codex/responses", path: "" },
      })
      expect(requests).toEqual([
        {
          url: "https://chatgpt.com/backend-api/codex/responses",
          headers: expect.objectContaining({
            authorization: "Bearer chatgpt-access",
            "chatgpt-account-id": "acct_123",
          }),
        },
      ])
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "Codex ready." })
      expect(JSON.stringify(requests)).not.toContain("must-not-project")
    }),
  )

  it.effect("maps catalog Google AI SDK models into native Gemini routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://google.example/v1/models/api-test-model:streamGenerateContent?alt=sse",
        body: "{}",
        headers: Headers.empty,
      })

      expect(resolved.route).toMatchObject({
        id: "gemini",
        endpoint: { baseURL: "https://google.example/v1" },
      })
      expect(headers["x-goog-api-key"]).toBe("secret")
      expect(JSON.stringify((yield* LLMClient.prepare(request)).body)).not.toContain("secret")
    }),
  )

  it.effect("configures Azure from resourceName and honors completion URL selection", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/azure" }),
          providerID: ProviderV2.ID.azure,
          request: {
            headers: {},
            body: {
              apiKey: "azure-secret",
              resourceName: "forge-resource",
              apiVersion: "2026-01-01",
              useCompletionUrls: true,
              temperature: 0.4,
            },
          },
        }),
      )
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )

      expect(resolved.route).toMatchObject({
        id: "azure-openai-chat",
        endpoint: {
          baseURL: "https://forge-resource.openai.azure.com/openai/v1",
          query: { "api-version": "2026-01-01" },
        },
      })
      expect(prepared.body).toMatchObject({ temperature: 0.4 })
      expect(JSON.stringify(prepared.body)).not.toContain("forge-resource")
      expect(JSON.stringify(prepared.body)).not.toContain("azure-secret")
    }),
  )

  it.effect("applies Agent request overrides after the selected catalog variant", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("variant"),
          headers: { "x-order": "variant" },
          body: { temperature: 0.2, custom_extension: { source: "variant" } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_agent_request"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("variant") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })
      const resolved = yield* SessionRunnerModel.resolve(session, catalog, undefined, {
        headers: { "x-order": "agent" },
        body: { temperature: 0.7, custom_extension: { source: "agent" } },
      })
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )

      expect(resolved.route.defaults.headers).toMatchObject({ "x-order": "agent" })
      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { source: "agent" } })
      expect(prepared.body).toMatchObject({ temperature: 0.7 })
    }),
  )

  it.effect("maps catalog Amazon Bedrock models into the native Converse route", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/amazon-bedrock" }),
          providerID: ProviderV2.ID.amazonBedrock,
          request: { headers: { "x-test": "header" }, body: { apiKey: "bedrock-secret", region: "eu-west-1" } },
        }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "amazon-bedrock" })
      expect(resolved.route).toMatchObject({
        id: "bedrock-converse",
        endpoint: { baseURL: "https://bedrock-runtime.eu-west-1.amazonaws.com" },
      })
      expect(
        JSON.stringify((yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))).body),
      ).not.toContain("bedrock-secret")
    }),
  )

  it.effect("uses allowlisted Bedrock credential metadata for SigV4 without serializing it", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/amazon-bedrock" }),
          providerID: ProviderV2.ID.amazonBedrock,
          api: {
            id: ModelV2.ID.make("anthropic.claude-3-5-sonnet-20241022-v2:0"),
            type: "aisdk",
            package: "@ai-sdk/amazon-bedrock",
          },
          request: { headers: {}, body: {} },
        }),
        Credential.Key.make({
          type: "key",
          key: "credential-record",
          metadata: {
            accessKeyId: "AKIAFORGETEST",
            secretAccessKey: "bedrock-secret-access",
            sessionToken: "bedrock-session-token",
            region: "eu-west-1",
            tenant: "must-not-leak",
          },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://bedrock-runtime.eu-west-1.amazonaws.com/model/converse-stream",
        body: "{}",
        headers: Headers.empty,
      })
      const prepared = yield* LLMClient.prepare(request)

      expect(String(resolved.id)).toBe("eu.anthropic.claude-3-5-sonnet-20241022-v2:0")
      expect(headers.authorization).toContain("Credential=AKIAFORGETEST/")
      expect(headers["x-amz-security-token"]).toBe("bedrock-session-token")
      expect(JSON.stringify(prepared.body)).not.toContain("bedrock-secret-access")
      expect(JSON.stringify(prepared.body)).not.toContain("must-not-leak")
    }),
  )

  it.effect("table-drives every model package exposed as selectable", () =>
    Effect.sync(() => {
      expect([...SessionRunnerModel.supportedPackages].toSorted()).toEqual(
        [
          "@ai-sdk/amazon-bedrock",
          "@ai-sdk/anthropic",
          "@ai-sdk/azure",
          "@ai-sdk/google",
          "@ai-sdk/openai",
          "@ai-sdk/openai-compatible",
          "@ai-sdk/xai",
          "@openrouter/ai-sdk-provider",
        ].toSorted(),
      )
      for (const packageName of SessionRunnerModel.supportedPackages) {
        const catalog = model({
          type: "aisdk",
          package: packageName,
          url: "https://provider.example/v1",
        })
        expect(SessionRunnerModel.supported(catalog)).toBe(true)
        expect(SessionRunnerModel.selectable(catalog)).toBe(true)
      }
      expect(SessionRunnerModel.supported(model({ type: "aisdk", package: "@ai-sdk/openai-compatible" }))).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "aisdk", package: "@ai-sdk/xai" }))).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
      expect(
        SessionRunnerModel.selectable(
          ModelV2.Info.make({
            ...model({ type: "aisdk", package: "@ai-sdk/openai" }),
            capabilities: { tools: false, input: ["text"], output: ["text"] },
          }),
        ),
      ).toBe(false)
    }),
  )
})

/**
 * Every price list below is transcribed from the live models.dev catalog as the
 * models-dev plugin lowers it (`packages/core/src/plugin/models-dev.ts`), not
 * from the shape the schema suggests: element 0 is always the untiered base,
 * context tiers are appended after it, and `tier.size` is a threshold the
 * request has to strictly exceed.
 */
describe("SessionRunnerModel.cost", () => {
  // openai/gpt-4o-mini: {input: 0.15, output: 0.6, cache_read: 0.075}, no
  // cache_write and no tiers.
  const flat = [{ input: 0.15, output: 0.6, cache: { read: 0.075, write: 0 } }]
  // opencode/claude-sonnet-4-5: base {3, 15, 0.3, 3.75} plus a >200k tier
  // {6, 22.5, 0.6, 7.5}, which upstream ships twice -- once under `tiers` and
  // once under the legacy `context_over_200k` -- so the lowered array really
  // does carry two identical size-200000 entries.
  const tiered = [
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { tier: { type: "context" as const, size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
    { tier: { type: "context" as const, size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  ]
  const tokens = (input: number, output: number, read = 0, write = 0, reasoning = 0) => ({
    input,
    output,
    reasoning,
    cache: { read, write },
  })
  const settle = (occupancy: ReturnType<typeof tokens>, processed = occupancy) => ({
    tokens: occupancy,
    processed,
  })

  test("prices a flat model off its one entry", () => {
    // 1_000 * 0.15 + 100 * 0.6 + 4_000 * 0.075 = 510 per million.
    expect(SessionRunnerModel.cost({ cost: flat }, settle(tokens(1_000, 100, 4_000)))).toBeCloseTo(0.00051, 12)
  })

  test("charges reasoning at the output rate", () => {
    // models.dev publishes no reasoning rate; V1 billed it as output and so does this.
    expect(SessionRunnerModel.cost({ cost: flat }, settle(tokens(0, 0, 0, 0, 1_000)))).toBeCloseTo(0.0006, 12)
  })

  test("stays on the base entry while the request fits under the tier threshold", () => {
    // 199_999 occupied: under the >200_000 threshold, so base rates.
    const occupancy = tokens(199_999, 1_000)
    expect(SessionRunnerModel.cost({ cost: tiered }, settle(occupancy))).toBeCloseTo(
      (199_999 * 3 + 1_000 * 15) / 1_000_000,
      12,
    )
  })

  test("promotes to the context tier once the request exceeds it, counting cached tokens as occupancy", () => {
    // 100_000 fresh + 100_001 cache-read is 200_001 in the window: over the line
    // even though only 100_000 tokens were freshly submitted.
    const occupancy = tokens(100_000, 1_000, 100_001)
    expect(SessionRunnerModel.cost({ cost: tiered }, settle(occupancy))).toBeCloseTo(
      (100_000 * 6 + 1_000 * 22.5 + 100_001 * 0.6) / 1_000_000,
      12,
    )
  })

  test("bills the whole turn while sizing the tier off a single request", () => {
    // The window held 10_000 at the last round trip -- under the tier -- but the
    // run processed 500_000. Base rates, cumulative multiplicand.
    const occupancy = tokens(10_000, 100)
    const processed = tokens(500_000, 4_000)
    expect(SessionRunnerModel.cost({ cost: tiered }, settle(occupancy, processed))).toBeCloseTo(
      (500_000 * 3 + 4_000 * 15) / 1_000_000,
      12,
    )
  })

  test("is free for a model the catalog has no pricing for", () => {
    // What `plugin/provider/claude-code.ts` sets: billed against a subscription.
    expect(SessionRunnerModel.cost({ cost: [] }, settle(tokens(100_000, 5_000, 900_000)))).toBe(0)
    // And what models.dev yields for the 400-odd entries with no `cost` key.
    const unpriced = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
    expect(SessionRunnerModel.cost({ cost: unpriced }, settle(tokens(100_000, 5_000, 900_000)))).toBe(0)
  })

  test("prefers a provider-authoritative charge over anything derived from tokens", () => {
    // GitHub Copilot bills in nano-AIU; 1e11 of them is a dollar.
    expect(
      SessionRunnerModel.cost(
        { cost: flat },
        { ...settle(tokens(1_000, 100)), metadata: { copilot: { totalNanoAiu: 4_473_525_000 } } },
      ),
    ).toBeCloseTo(0.04473525, 12)
  })

  test("settles both halves of the event from one call", () => {
    const processed = tokens(3_000, 120, 150_000, 2_000, 30)
    expect(SessionRunnerModel.settle({ cost: flat }, settle(tokens(1_000, 40, 50_000), processed))).toEqual({
      cost: (3_000 * 0.15 + 120 * 0.6 + 30 * 0.6 + 150_000 * 0.075) / 1_000_000,
      billed: processed,
    })
  })
})
