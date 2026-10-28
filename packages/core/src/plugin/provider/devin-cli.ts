export * as ProviderDevinCLI from "./devin-cli"

import { Effect } from "effect"
import { Config } from "../../config"
import { DevinCLI } from "../../provider/devin-cli"
import { define } from "../define"

/** Availability means installed, not authenticated. The runtime checks login on use. */
export const DevinCLIPlugin = define({
  id: "devin-cli",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        // Project config must not select an executable. Match the global routing boundary.
        const boundary = entries.findIndex((entry) => entry.type === "directory")
        const executable = (boundary < 0 ? entries : entries.slice(0, boundary))
          .filter((entry): entry is Config.Document => entry.type === "document")
          .flatMap((entry) => {
            const value = entry.info.providers?.[DevinCLI.ID]?.request?.body?.[DevinCLI.EXECUTABLE_KEY]
            return value === undefined ? [] : [value]
          })
          .at(-1)
        const probe = yield* Effect.promise(() => DevinCLI.probe(executable))
        catalog.provider.update(DevinCLI.ID, (provider) => {
          provider.name = DevinCLI.NAME
          provider.disabled = probe.status !== "installed"
          provider.api = { type: "native", url: DevinCLI.API_URL, settings: {} }
          if (probe.status === "installed") {
            provider.request.body[DevinCLI.EXECUTABLE_KEY] = probe.executable
          } else {
            delete provider.request.body[DevinCLI.EXECUTABLE_KEY]
          }
        })
        for (const item of DevinCLI.MODELS) {
          catalog.model.update(DevinCLI.ID, item.id, (model) => {
            model.name = item.name
            model.api = { type: "native", id: item.apiID, url: DevinCLI.API_URL, settings: {} }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.variants = []
            // The user's Devin plan controls billing. Do not invent API costs.
            model.cost = []
            model.status = "active"
            model.enabled = true
            // Do not prefer a CLI for automatic background model selection.
            model.time.released = 0
            model.limit = { context: item.context, output: item.output }
          })
        }
      }),
    )
  }),
})
