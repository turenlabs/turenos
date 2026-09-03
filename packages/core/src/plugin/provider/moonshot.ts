import { Effect } from "effect"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"

export const retiredModels = new Set([
  "kimi-k2-0711-preview",
  "kimi-k2-0905-preview",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "kimi-k2-turbo-preview",
])

export const MoonshotPlugin = {
  id: "moonshot",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      const provider = catalog.provider.get(ProviderV2.ID.make("moonshotai"))
      if (!provider) return
      for (const model of provider.models.values()) {
        if (!retiredModels.has(model.api.id)) continue
        catalog.model.update(provider.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })
  }),
} satisfies PluginInternal.Plugin<PluginInternal.Requirements>
