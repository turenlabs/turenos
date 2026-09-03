import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@turenlabs/core/catalog"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { MoonshotPlugin } from "@turenlabs/core/plugin/provider/moonshot"
import { ProviderV2 } from "@turenlabs/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* MoonshotPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

describe("MoonshotPlugin", () => {
  it.effect("disables retired Kimi models without hiding Kimi K3", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("moonshotai")
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
        })
        for (const id of ["kimi-k2-thinking", "kimi-k3"]) {
          editor.model.update(providerID, ModelV2.ID.make(id), (model) => {
            model.api = {
              id: ModelV2.ID.make(id),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
            }
          })
        }
      })
      yield* addPlugin()

      expect(required(yield* catalog.model.get(providerID, ModelV2.ID.make("kimi-k2-thinking"))).enabled).toBe(false)
      expect(required(yield* catalog.model.get(providerID, ModelV2.ID.make("kimi-k3"))).enabled).toBe(true)
    }),
  )
})
