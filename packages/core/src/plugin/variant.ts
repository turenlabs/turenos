export * as VariantPlugin from "./variant"

import { Effect } from "effect"
import { define } from "./define"
import type { ModelV2Info } from "@turenlabs/plugin/v2/types"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            const generated = generate(draft)
            if (generated.length > 0) {
              const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
              const generatedIDs = new Set(generated.map((variant) => variant.id))
              draft.variants = [
                ...generated.map((variant) => explicit.get(variant.id) ?? variant),
                ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
              ]
            }
            // Runs after config, so a configured `request.variant` wins.
            draft.request.variant ??= defaultVariant(draft)
          })
        }
      }
    })
  }),
})

export function generate(model: ModelV2Info): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk" || model.api.package !== "@ai-sdk/openai-compatible") return []
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id,
    headers: {},
    body: { reasoning_effort: id },
  }))
}

/**
 * The level a turn runs at when the user picks none. Without one the provider decides, and
 * Anthropic runs adaptive-thinking Claude models with thinking off. Defaults are only chosen
 * from published variants, and only where they match what V1 already sends
 * (`ProviderTransform.options` and `LLMRequestPrep.prepare`).
 */
export function defaultVariant(model: ModelV2Info) {
  if (model.api.type !== "aisdk") return
  const published = (id: string) => model.variants.find((variant) => variant.id === id)?.id
  if (model.api.package === "@ai-sdk/anthropic" || model.api.package === "@ai-sdk/google-vertex/anthropic") {
    // Anthropic's own effort default. Budget-based models are left alone: their "high" is a
    // fixed 16k thinking budget on every turn, a much larger cost change than enabling
    // adaptive thinking.
    const thinking = model.variants.find((variant) => variant.id === "high")?.body.thinking
    return typeof thinking === "object" && thinking !== null && "type" in thinking && thinking.type === "adaptive"
      ? published("high")
      : undefined
  }
  if (model.api.package !== "@ai-sdk/openai" && model.api.package !== "@ai-sdk/azure") return
  const id = model.api.id.toLowerCase()
  if (!id.includes("gpt-5") || id.includes("gpt-5-chat") || /gpt-5(?:[.-]\d+)?[.-]pro(?:[.-]|$)/.test(id)) return
  return published("medium")
}
