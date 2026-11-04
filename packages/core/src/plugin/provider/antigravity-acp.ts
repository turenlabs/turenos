import { Effect } from "effect"
import { define } from "../define"
import { Config } from "../../config"
import { AntigravityAcpCLI } from "../../provider/antigravity-acp"
import { ProviderV2 } from "../../provider"
import { ModelV2 } from "../../model"

/** Availability means installed, not authenticated; login is checked on use. */
export const AntigravityAcpPlugin = define({
  id: "antigravity-acp",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        // Like ConfigProviderPlugin, only documents before the global directory
        // may choose the executable: project configuration is repository-controlled.
        const boundary = entries.findIndex((entry) => entry.type === "directory")
        const configured = (boundary < 0 ? entries : entries.slice(0, boundary))
          .flatMap((entry) =>
            entry.type === "document"
              ? [entry.info.providers?.[AntigravityAcpCLI.ID]?.request?.body?.[AntigravityAcpCLI.EXECUTABLE_KEY]]
              : [],
          )
          .findLast((value) => value !== undefined)
        const probe = yield* Effect.promise(() => AntigravityAcpCLI.probe(configured))
        const upstream = catalog.provider.get(ProviderV2.ID.make(AntigravityAcpCLI.CATALOG_PROVIDER))
        catalog.provider.update(AntigravityAcpCLI.ID, (provider) => {
          provider.name = AntigravityAcpCLI.NAME
          provider.disabled = probe.status !== "installed"
          provider.api = { type: "native", url: AntigravityAcpCLI.API_URL, settings: {} }
          if (probe.status === "installed") {
            provider.request.body[AntigravityAcpCLI.EXECUTABLE_KEY] = probe.executable
          } else {
            delete provider.request.body[AntigravityAcpCLI.EXECUTABLE_KEY]
          }
        })
        for (const item of AntigravityAcpCLI.MODELS) {
          catalog.model.update(AntigravityAcpCLI.ID, item.id, (model) => {
            model.name = item.name
            model.family = item.family
            model.api = { type: "native", id: item.apiID, url: AntigravityAcpCLI.API_URL, settings: {} }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.variants = item.efforts.map((effort) => ({
              id: effort,
              headers: {},
              body: { [AntigravityAcpCLI.EFFORT_KEY]: effort },
            }))
            // Subscription-backed, not per-token API pricing.
            model.cost = []
            model.status = "active"
            model.enabled = true
            // Do not prefer a CLI for automatic background model selection.
            model.time.released = 0
            model.limit = AntigravityAcpCLI.windowFor(item, upstream?.models.get(ModelV2.ID.make(item.apiID))?.limit)
          })
        }
      }),
    )
  }),
})
