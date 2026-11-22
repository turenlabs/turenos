export * as VariantPlugin from "./variant"

import { Effect } from "effect"
import { define } from "./define"
import { Catalog } from "../catalog"
import { ModelV2 } from "../model"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((catalog) => {
      catalog.model.forEach((model) => {
        const generated = generate(model)
        // Runs after config, so a configured `request.variant` wins.
        const fallback = model.request.variant === undefined ? defaultVariant(model) : undefined
        if (generated.length === 0 && fallback === undefined && typeof model.request.body.baseURL !== "string") return
        catalog.model.update(model.providerID, model.id, (draft) => {
          if (generated.length > 0) {
            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          }
          draft.request.variant ??= fallback
        })
      })
    })
  }),
})

export function generate(model: ModelV2.Info): ModelV2.MutableInfo["variants"] {
  if (model.api.type !== "aisdk" || model.api.package !== "@ai-sdk/openai-compatible") return []
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id: ModelV2.VariantID.make(id),
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
export function defaultVariant(model: ModelV2.Info) {
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
