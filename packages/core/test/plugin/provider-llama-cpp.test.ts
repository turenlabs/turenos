import { describe, expect, test } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { Config } from "@turenlabs/core/config"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { LlamaCppPlugin, normalizeLlamaCppEndpoint } from "@turenlabs/core/plugin/provider/llama-cpp"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = ProviderV2.ID.make("llama-cpp")
const endpoint = "http://127.0.0.1:28080"
const decode = Schema.decodeUnknownSync(Config.Info)
const emptyConfig = Config.Service.of({ entries: () => Effect.succeed([]) })

const respond = (request: { url: string }, models: unknown[], nCtx = 131_072) =>
  HttpClientResponse.fromWeb(
    request as never,
    request.url.endsWith("/props")
      ? Response.json({ default_generation_settings: { n_ctx: nCtx }, total_slots: 1 })
      : Response.json({ object: "list", data: models }),
  )

describe("LlamaCppPlugin", () => {
  it.effect("publishes discovered local models to the runtime catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const requests: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return respond(request, [
            { id: "models/qwen3-8b.gguf", object: "model", created: 1_700_000_000, owned_by: "llamacpp" },
            { id: "unsloth/llama-3.2-3b-instruct", object: "model", created: 0 },
          ])
        }),
      )
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  "llama-cpp": {
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${endpoint}/v1` },
                  },
                },
              }),
            }),
          ]),
      })
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(requests).toEqual([`${endpoint}/v1/models`, `${endpoint}/props`])
      expect(yield* catalog.provider.get(providerID)).toMatchObject({
        name: "llama.cpp",
        api: { package: "@ai-sdk/openai-compatible", url: `${endpoint}/v1` },
        request: { body: { apiKey: "llamacpp" } },
      })

      const models = yield* catalog.model.available()
      expect(models.map((model) => model.id)).toEqual([
        ModelV2.ID.make("models/qwen3-8b.gguf"),
        ModelV2.ID.make("unsloth/llama-3.2-3b-instruct"),
      ])
      expect(models.every(SessionRunnerModel.selectable)).toBe(true)
      // Context window comes from llama-server /props, not a fixed default.
      expect(models[0].limit.context).toBe(131_072)

      const selected = models.find((model) => model.id === ModelV2.ID.make("models/qwen3-8b.gguf"))
      if (!selected) throw new Error("Expected discovered llama.cpp model")
      const resolved = yield* SessionRunnerModel.resolveWithRef(
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_llama_cpp_catalog"),
          projectID: ProjectV2.ID.global,
          title: "llama.cpp catalog",
          model: { providerID, id: selected.id },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/project") },
        }),
        selected,
      )
      expect(resolved.model.route.endpoint.baseURL).toBe(`${endpoint}/v1`)
      expect(resolved.model.route.defaults.http?.redirect).toBe("error")
    }),
  )

  it.effect("does not publish a catalog when the server is unreachable", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("connection refused") }),
          }),
        ),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )

  it.effect("registers the provider when the server is up with no models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const http = HttpClient.make((request) => Effect.sync(() => respond(request, [])))
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      const provider = yield* catalog.provider.get(providerID)
      // No config entry, so discovery used the default llama-server port.
      expect(provider?.api).toMatchObject({ url: "http://127.0.0.1:8080/v1" })
      expect(yield* catalog.model.available()).toEqual([])
    }),
  )

  it.effect("does not publish a partial catalog from malformed model entries", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const http = HttpClient.make((request) =>
        Effect.succeed(respond(request, [{ id: "valid.gguf" }, { id: "   " }])),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )

  it.effect("falls back to the default context window when /props is unavailable", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const http = HttpClient.make((request) =>
        request.url.endsWith("/props")
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: new Error("unsupported") }),
              }),
            )
          : Effect.succeed(respond(request, [{ id: "model.gguf" }])),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("model.gguf"))).toMatchObject({
        limit: { context: 32_768 },
      })
    }),
  )

  it.effect("uses LLAMA_CPP_HOST when no config endpoint is set", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const previous = process.env.LLAMA_CPP_HOST
      process.env.LLAMA_CPP_HOST = "http://127.0.0.1:28081"
      const http = HttpClient.make((request) => Effect.succeed(respond(request, [{ id: "model.gguf" }])))
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      try {
        yield* LlamaCppPlugin.effect(host).pipe(
          Effect.provideService(Config.Service, emptyConfig),
          Effect.provideService(HttpClient.HttpClient, http),
        )
      } finally {
        if (previous === undefined) delete process.env.LLAMA_CPP_HOST
        else process.env.LLAMA_CPP_HOST = previous
      }

      expect(yield* catalog.provider.get(providerID)).toMatchObject({
        api: { url: "http://127.0.0.1:28081/v1" },
      })
    }),
  )

  it.effect("refreshes the catalog when llama-server starts after TurenOS", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      let requests = 0
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const isModels = !request.url.endsWith("/props")
          if (isModels) requests++
          return respond(request, requests <= 1 ? [] : [{ id: "late-model.gguf" }])
        }),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* LlamaCppPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )
      // Reachable from the start, but only registers once a model is served.
      expect(yield* catalog.model.available()).toEqual([])

      yield* TestClock.adjust("10 seconds")

      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("late-model.gguf"))).toBeDefined()
    }),
  )
})

test("normalizeLlamaCppEndpoint accepts only loopback HTTP endpoints", () => {
  expect(normalizeLlamaCppEndpoint(undefined)).toBe("http://127.0.0.1:8080")
  expect(normalizeLlamaCppEndpoint("localhost:8080/v1")).toBe("http://localhost:8080")
  expect(normalizeLlamaCppEndpoint("http://[::1]:8080/v1/")).toBe("http://[::1]:8080")
  expect(normalizeLlamaCppEndpoint("https://example.com:8080")).toBeUndefined()
  expect(normalizeLlamaCppEndpoint("http://user:pass@localhost:8080")).toBeUndefined()
  expect(normalizeLlamaCppEndpoint("http://127.0.0.1:8080/v1?key=x")).toBeUndefined()
})

test("LlamaCppPlugin is registered as a built-in provider", () => {
  expect(ProviderPlugins.some((plugin) => plugin.id === LlamaCppPlugin.id)).toBe(true)
})
