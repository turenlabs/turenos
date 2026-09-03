import { Effect } from "effect"
import { define } from "../define"

export const NvidiaPlugin = define({
  id: "nvidia",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://integrate.api.nvidia.com/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://github.com/turenlabs/forge/"
            provider.request.headers["X-Title"] = "Forge"
            provider.request.headers["X-BILLING-INVOKE-ORIGIN"] ??= "Forge"
          })
        }
      }),
    )
  }),
})
