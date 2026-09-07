import { Effect } from "effect"
import { define } from "../define"
import { MuseCodeCLI } from "../../provider/muse-code"
import { ProviderV2 } from "../../provider"
import { ModelV2 } from "../../model"

/** Availability means installed, not authenticated; login is checked on use. */
export const MuseCodePlugin = define({
  id: "muse-code",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const probe = yield* Effect.promise(() => MuseCodeCLI.probe())
        const upstream = catalog.provider.get(ProviderV2.ID.make(MuseCodeCLI.CATALOG_PROVIDER))
        catalog.provider.update(MuseCodeCLI.ID, (provider) => {
          provider.name = MuseCodeCLI.NAME
          provider.disabled = probe.status !== "installed"
          provider.api = { type: "native", url: MuseCodeCLI.API_URL, settings: {} }
          if (probe.status === "installed") {
            provider.request.body[MuseCodeCLI.EXECUTABLE_KEY] = probe.executable
          } else {
            delete provider.request.body[MuseCodeCLI.EXECUTABLE_KEY]
          }
        })
        for (const item of MuseCodeCLI.MODELS) {
          catalog.model.update(MuseCodeCLI.ID, item.id, (model) => {
            model.name = item.name
            model.family = item.family
            model.api = { type: "native", id: item.apiID, url: MuseCodeCLI.API_URL, settings: {} }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.variants = item.efforts.map((effort) => ({
              id: effort,
              headers: {},
              body: { [MuseCodeCLI.EFFORT_KEY]: effort },
            }))
            // Subscription-backed, not per-token API pricing.
            model.cost = []
            model.status = "active"
            model.enabled = true
            // Do not prefer a CLI for automatic background model selection.
            model.time.released = 0
            model.limit = MuseCodeCLI.windowFor(item, upstream?.models.get(ModelV2.ID.make(item.apiID))?.limit)
          })
        }
      }),
    )
  }),
})
