import { Effect } from "effect"
import { pathToFileURL } from "url"
import { define } from "../define"
import { Npm } from "../../npm"
import { ProviderV2 } from "../../provider"

export const SapAICorePlugin = define({
  id: "sap-ai-core",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("sap-ai-core")) return
        const serviceKey = process.env.AICORE_SERVICE_KEY
        if (!serviceKey && (typeof evt.options.serviceKey === "string" || typeof evt.options.apiKey === "string")) {
          throw new Error(
            "Stored SAP AI Core credentials cannot be applied without exposing them process-wide. Set AICORE_SERVICE_KEY in the TurenOS server environment.",
          )
        }

        const installedPath = evt.package.startsWith("file://")
          ? evt.package
          : (yield* npm.add(evt.package).pipe(Effect.orDie)).entrypoint
        if (!installedPath) throw new Error(`Package ${evt.package} has no import entrypoint`)

        const mod = yield* Effect.promise(async () => {
          return (await import(
            installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
          )) as Record<string, (options: any) => any>
        }).pipe(Effect.orDie)
        const match = Object.keys(mod).find((name) => name.startsWith("create"))
        if (!match) throw new Error(`Package ${evt.package} has no provider factory export`)

        evt.sdk = mod[match](
          serviceKey
            ? { deploymentId: process.env.AICORE_DEPLOYMENT_ID, resourceGroup: process.env.AICORE_RESOURCE_GROUP }
            : {},
        )
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("sap-ai-core")) return
        evt.language = evt.sdk(evt.model.api.id)
      }),
    )
  }),
})
