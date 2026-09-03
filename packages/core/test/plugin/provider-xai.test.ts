import { AISDK } from "@turenlabs/core/aisdk"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/core/integration"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { XAIPlugin } from "@turenlabs/core/plugin/provider/xai"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  const integrations = yield* Integration.Service
  yield* XAIPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integrations))
})

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

const response = () =>
  Response.json({
    id: "response-1",
    created_at: 0,
    model: "grok-4",
    object: "response",
    output: [],
    usage: { input_tokens: 1, output_tokens: 0 },
    status: "completed",
  })

const xaiModel = (url?: string, modelID = "grok-4") =>
  ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("xai"), ModelV2.ID.make(modelID)),
    api: {
      id: ModelV2.ID.make(modelID),
      type: "aisdk",
      package: "@ai-sdk/xai",
      ...(url === undefined ? {} : { url }),
    },
  })

const doGenerate = (language: LanguageModelV3) =>
  language.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  })

describe("XAIPlugin", () => {
  it.effect("registers SuperGrok OAuth refresh for auth.json tokens", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("xai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("grok-browser"),
          type: "oauth",
          label: "xAI Grok OAuth (SuperGrok Subscription)",
        },
      ])
    }),
  )

  it.effect("refreshes expired SuperGrok OAuth before a V2 request", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      const originalFetch = globalThis.fetch
      const tokenRequests: string[] = []
      using server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          if (url.pathname === "/oauth2/token") {
            tokenRequests.push(await request.text())
            return Response.json({ access_token: "fresh-access", refresh_token: "rt-new", expires_in: 3600 })
          }
          return new Response("unexpected", { status: 500 })
        },
      })
      globalThis.fetch = (async (input, init) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url === "https://auth.x.ai/oauth2/token") {
          return originalFetch(new URL("/oauth2/token", server.url), init)
        }
        return originalFetch(input, init)
      }) as typeof fetch
      try {
        yield* addPlugin()
        const created = yield* credentials.create({
          integrationID: Integration.ID.make("xai"),
          value: Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("grok-browser"),
            access: "stale-access",
            refresh: "rt-old",
            expires: 1,
          }),
        })
        const connection = (yield* integrations.connection.active(Integration.ID.make("xai")))!
        const resolved = yield* integrations.connection.resolve(connection)
        expect(resolved).toMatchObject({ type: "oauth", access: "fresh-access", refresh: "rt-new" })
        expect(tokenRequests).toHaveLength(1)
        expect(tokenRequests[0]).toContain("refresh_token=rt-old")
        expect((yield* credentials.get(created.id))?.value).toMatchObject({
          type: "oauth",
          access: "fresh-access",
          refresh: "rt-new",
        })
      } finally {
        globalThis.fetch = originalFetch
      }
    }),
  )

  it.effect("creates an xAI SDK only for @ai-sdk/xai", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const ignored = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("xai"), ModelV2.ID.make("grok-4")),
          api: { id: ModelV2.ID.make("grok-4"), type: "aisdk", package: "@ai-sdk/xai" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: {},
      })

      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("xai"), ModelV2.ID.make("grok-4")),
          api: { id: ModelV2.ID.make("grok-4"), type: "aisdk", package: "@ai-sdk/xai" },
        }),
        package: "@ai-sdk/xai",
        options: {},
      })

      expect(ignored.sdk).toBeUndefined()
      expect(typeof result.sdk?.responses).toBe("function")
    }),
  )

  it.effect("creates xAI SDKs for custom provider IDs", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-xai"), ModelV2.ID.make("grok-4")),
          api: { id: ModelV2.ID.make("grok-4"), type: "aisdk", package: "@ai-sdk/xai" },
        }),
        package: "@ai-sdk/xai",
        options: {},
      })

      expect(result.sdk.responses("grok-4").provider).toBe("xai.responses")
    }),
  )

  it.effect("uses responses with the model api.id for xAI language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []

      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("xai"), ModelV2.ID.make("alias")),
          api: { id: ModelV2.ID.make("grok-4"), type: "aisdk", package: "@ai-sdk/xai" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })

      expect(calls).toEqual(["responses:grok-4"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("routes V2 xAI OAuth through the Grok CLI proxy", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const captured: { url?: string; init?: RequestInit } = {}
      const fetch = Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          captured.url = input instanceof Request ? input.url : String(input)
          captured.init = init
          return response()
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      let language: LanguageModelV3 | undefined

      yield* aisdk.hook.sdk((event) => {
        if (event.package === "@ai-sdk/xai") event.options.fetch = fetch
      })
      yield* addPlugin()
      yield* aisdk.hook.language((event) => {
        if (event.model.providerID === ProviderV2.ID.make("xai")) language = event.language
      })

      yield* SessionRunnerModel.fromCatalogModelWithAISDK(
        xaiModel("https://api.x.ai/v1", "grok-4.6"),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("xai-test"),
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        }),
      )

      expect(language).toBeDefined()
      yield* Effect.promise(() => doGenerate(language!))

      const headers = new Headers(captured.init?.headers)
      expect(captured.url).toBe("https://cli-chat-proxy.grok.com/v1/responses")
      expect(captured.init?.method).toBe("POST")
      expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli")
      expect(headers.get("x-grok-client-identifier")).toBe("grok-shell")
      expect(headers.get("x-grok-client-version")).toBe(process.env.GROK_CLI_VERSION?.trim() || "0.2.103")
      expect(headers.get("x-grok-model-override")).toBe("grok-4.6")
      expect(headers.get("User-Agent")).toStartWith("xai-grok-cli")
      expect(JSON.parse(String(captured.init?.body)).model).toBe("grok-4.6")
    }),
  )

  it.effect("keeps API-key xAI and custom gateway endpoints unchanged", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const captured: Array<{ url?: string; init?: RequestInit }> = []
      const fetch = Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          captured.push({
            url: input instanceof Request ? input.url : String(input),
            init,
          })
          return response()
        },
        { preconnect: globalThis.fetch.preconnect },
      )

      yield* addPlugin()
      for (const url of ["https://api.x.ai/v1", "https://gateway.example/v1"]) {
        const result = yield* aisdk.runSDK({
          model: xaiModel(url),
          package: "@ai-sdk/xai",
          options: { apiKey: "api-key", baseURL: url, fetch },
        })
        yield* Effect.promise(() => doGenerate(result.sdk.responses("grok-4")))
      }

      expect(captured.map((item) => item.url)).toEqual([
        "https://api.x.ai/v1/responses",
        "https://gateway.example/v1/responses",
      ])
      captured.forEach((item) => {
        const headers = new Headers(item.init?.headers)
        expect(headers.get("X-XAI-Token-Auth")).toBeNull()
        expect(headers.get("x-grok-client-identifier")).toBeNull()
        expect(headers.get("x-grok-client-version")).toBeNull()
        expect(headers.get("x-grok-model-override")).toBeNull()
      })
    }),
  )

  it.effect("ignores non-xAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []

      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("grok-4")),
          api: { id: ModelV2.ID.make("grok-4"), type: "aisdk", package: "@ai-sdk/xai" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })

      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )
})
