export * as ProviderDevinCLI from "./devin-cli"

import { Cache, Effect } from "effect"
import { existsSync } from "node:fs"
import { Config } from "../../config"
import { DevinCLI } from "../../provider/devin-cli"
import { DevinACP } from "../../session/runner/devin-acp"
import { DevinOptions } from "../../session/runner/devin-options"
import { define } from "../define"

/** An installed CLI always has its default route. A signed-in session can advertise more models. */
export const DevinCLIPlugin = define({
  id: "devin-cli",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const discovery = yield* Cache.make({ capacity: 4, timeToLive: "30 seconds", lookup: DevinACP.discover })
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
        const installed = probe.status === "installed" ? probe.executable : undefined
        const credentials = DevinACP.credentialsPath()
        const choices =
          installed && process.platform !== "win32" && credentials && existsSync(credentials)
            ? yield* Cache.get(discovery, installed)
            : []
        const fallback = DevinCLI.MODELS[0]!
        const models = [
          fallback,
          ...choices
            .filter((choice) => choice.id !== fallback.id)
            .map((choice) => ({
              ...fallback,
              ...choice,
              apiID: choice.id,
            })),
        ]
        for (const item of models) {
          catalog.model.update(DevinCLI.ID, item.id, (model) => {
            model.name = item.name
            model.api = { type: "native", id: item.apiID, url: DevinCLI.API_URL, settings: {} }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            const options = installed ? DevinACP.observedOptions(installed, item.apiID) : undefined
            model.variants = options
              ? DevinOptions.variants(options).map((variant) => ({ ...variant, headers: {} }))
              : []
            // The user's Devin plan controls billing. Do not invent API costs.
            model.cost = []
            model.status = "active"
            model.enabled = true
            // Do not prefer a CLI for automatic background model selection.
            model.time.released = 0
            const context = installed
              ? DevinACP.observedContext({ executable: installed, modelID: item.apiID })
              : undefined
            model.limit = { context: context ?? item.context, output: item.output }
          })
        }
      }),
    )
  }),
})
