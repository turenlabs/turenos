import { describe, expect, test } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { Config } from "@turenlabs/core/config"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { normalizeOllamaEndpoint, OllamaPlugin } from "@turenlabs/core/plugin/provider/ollama"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = ProviderV2.ID.make("ollama")
const endpoint = "http://127.0.0.1:22434"
const decode = Schema.decodeUnknownSync(Config.Info)
const emptyConfig = Config.Service.of({ entries: () => Effect.succeed([]) })

describe("OllamaPlugin", () => {
  it.effect("publishes discovered local models to the runtime catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const requests: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url)
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              models: [
                {
                  name: "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M",
                  modified_at: "2026-08-01T12:00:00Z",
                  details: { family: "ornith", parameter_size: "9B" },
                },
                { model: "gemma4-e2b-skill-ceiling:latest", details: { family: "gemma" } },
              ],
            }),
          )
        }),
      )
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  ollama: {
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${endpoint}/v1` },
                  },
                },
              }),
            }),
          ]),
      })
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* OllamaPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(requests).toEqual([`${endpoint}/api/tags`])
      expect(yield* catalog.provider.get(providerID)).toMatchObject({
        name: "Ollama",
        api: { package: "@ai-sdk/openai-compatible", url: `${endpoint}/v1` },
        request: { body: { apiKey: "ollama" } },
      })

      const models = yield* catalog.model.available()
      expect(models.map((model) => model.id)).toEqual([
        ModelV2.ID.make("hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M"),
        ModelV2.ID.make("gemma4-e2b-skill-ceiling:latest"),
      ])
      expect(models.every(SessionRunnerModel.selectable)).toBe(true)

      const selected = models.find((model) => model.id === ModelV2.ID.make("gemma4-e2b-skill-ceiling:latest"))
      if (!selected) throw new Error("Expected discovered Ollama model")
      const resolved = yield* SessionRunnerModel.resolveWithRef(
        SessionV2.Info.make({
          id: SessionV2.ID.make("ses_ollama_catalog"),
          projectID: ProjectV2.ID.global,
          title: "Ollama catalog",
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

  it.effect("does not publish a partial catalog from malformed tags", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ models: [{ name: "valid:latest" }, { name: "   ", model: "" }] }),
          ),
        ),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* OllamaPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )

      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )

  it.effect("refreshes the catalog when Ollama starts after TurenOS", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      let requests = 0
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            Response.json({ models: requests++ === 0 ? [] : [{ name: "late-model:latest" }] }),
          ),
        ),
      )
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* OllamaPlugin.effect(host).pipe(
        Effect.provideService(Config.Service, emptyConfig),
        Effect.provideService(HttpClient.HttpClient, http),
      )
      expect(yield* catalog.provider.get(providerID)).toBeUndefined()

      yield* TestClock.adjust("10 seconds")

      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("late-model:latest"))).toBeDefined()
    }),
  )
})

test("normalizeOllamaEndpoint accepts only loopback HTTP endpoints", () => {
  expect(normalizeOllamaEndpoint(undefined)).toBe("http://127.0.0.1:11434")
  expect(normalizeOllamaEndpoint("localhost:11434/v1")).toBe("http://localhost:11434")
  expect(normalizeOllamaEndpoint("http://[::1]:11434/v1/")).toBe("http://[::1]:11434")
  expect(normalizeOllamaEndpoint("https://example.com:11434")).toBeUndefined()
  expect(normalizeOllamaEndpoint("http://user:pass@localhost:11434")).toBeUndefined()
})

test("OllamaPlugin is registered as a built-in provider", () => {
  expect(ProviderPlugins.some((plugin) => plugin.id === OllamaPlugin.id)).toBe(true)
})
