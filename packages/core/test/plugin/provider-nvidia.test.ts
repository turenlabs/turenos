import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@turenlabs/core/catalog"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { NvidiaPlugin } from "@turenlabs/core/plugin/provider/nvidia"
import { ProviderV2 } from "@turenlabs/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* NvidiaPlugin.effect(host)
})

describe("NvidiaPlugin", () => {
  it.effect("is registered so legacy referer headers can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(PluginV2.ID.make("nvidia"))),
  )

  it.effect("applies NVIDIA tracking headers only to nvidia", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("nvidia"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://integrate.api.nvidia.com/v1",
          }
          provider.request = { headers: { Existing: "value" }, body: {} }
        })
        catalog.provider.update(ProviderV2.ID.openrouter, () => {})
      })
      yield* addPlugin()
      expect((yield* catalog.provider.get(ProviderV2.ID.make("nvidia")))?.request.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://github.com/turenlabs/forge/",
        "X-Title": "Forge",
        "X-BILLING-INVOKE-ORIGIN": "Forge",
      })
      expect((yield* catalog.provider.get(ProviderV2.ID.openrouter))?.request.headers).toEqual({})
    }),
  )

  it.effect("adds billing origin for custom NVIDIA endpoints", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("nvidia"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://integrate.api.nvidia.com/v1",
          }
        })
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(ProviderV2.ID.make("nvidia")))?.request.headers).toEqual({
        "HTTP-Referer": "https://github.com/turenlabs/forge/",
        "X-Title": "Forge",
        "X-BILLING-INVOKE-ORIGIN": "Forge",
      })
    }),
  )

  it.effect("preserves an explicit NVIDIA billing origin header", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("nvidia"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://integrate.api.nvidia.com/v1",
          }
          provider.request = {
            headers: { "X-BILLING-INVOKE-ORIGIN": "CustomOrigin" },
            body: { baseURL: "https://integrate.api.nvidia.com/v1" },
          }
        })
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(ProviderV2.ID.make("nvidia")))?.request.headers).toEqual({
        "HTTP-Referer": "https://github.com/turenlabs/forge/",
        "X-Title": "Forge",
        "X-BILLING-INVOKE-ORIGIN": "CustomOrigin",
      })
    }),
  )
})
