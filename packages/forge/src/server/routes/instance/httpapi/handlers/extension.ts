import { ExtensionManager } from "@/extension"
import { Extension } from "@turenlabs/schema"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Cause, Effect, RcMap } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { isLocalPlacement, isLocalRequest } from "@/server/shared/local-request"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { ToolVisibleError } from "@turenlabs/core/tool/visible-error"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.fail(new InvalidRequestError({ message: ToolVisibleError.make(Cause.squash(cause)) })),
    ),
  )

export function localExtensionRequest(input: {
  readonly workspaceID?: string
  readonly inProcess: boolean
  readonly remoteAddress?: string
}) {
  return isLocalPlacement(input)
}

const admission = Effect.fnUntraced(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return { local: isLocalRequest(request) }
})

export const extensionListHandlers = HttpApiBuilder.group(InstanceHttpApi, "extensionRead", (handlers) =>
  handlers.handle("list", () =>
    safe(
      Effect.gen(function* () {
        const placement = yield* admission()
        const items = yield* ExtensionManager.list()
        if (placement.local) return items
        return items.map((item) =>
          item.manifest.contributions.some((contribution) => "localOnly" in contribution && contribution.localOnly)
            ? new Extension.Item({
                manifest: item.manifest,
                origin: item.origin,
                mutable: false,
                enabled: item.enabled,
                status: item.status,
                detail: item.detail,
                installed: item.installed,
                secretsSet: item.secretsSet,
                configurationSet: item.configurationSet,
              })
            : item,
        )
      }),
    ),
  ),
)

export const extensionHandlers = HttpApiBuilder.group(InstanceHttpApi, "extensions", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const invalidate = (manifest: Extension.Manifest | undefined) => {
      const runtimeManaged = manifest?.contributions.some(
        (contribution) => contribution.adapter.startsWith("security:") || contribution.adapter.startsWith("mcp:"),
      )
      if (runtimeManaged) return Effect.void
      return Effect.gen(function* () {
        const refs = yield* RcMap.keys(locations.rcMap)
        yield* Effect.forEach([...refs], (ref) => locations.invalidate(ref), { discard: true })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to invalidate Location services after extension update", { cause }),
        ),
      )
    }
    return handlers.handle("update", (ctx) =>
      Effect.gen(function* () {
        const trace = {
          operationID: ctx.payload.operationID ?? "extension-untracked",
          extensionID: ctx.params.id,
          enabled: ctx.payload.enabled,
          connect: ctx.payload.connect === true,
        }
        yield* Effect.logInfo("Extension HTTP update received", trace)
        return yield* safe(
          ExtensionManager.update(ctx.params.id, ctx.payload, yield* admission()).pipe(
            Effect.tap((items) =>
              Effect.logInfo("Extension HTTP update completed", { ...trace, itemCount: items.length }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Extension HTTP update failed", { ...trace, cause }).pipe(
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
            Effect.tap(() => invalidate(ctx.payload.manifest ?? ExtensionCatalog.get(ctx.params.id))),
          ),
        )
      }),
    )
  }),
)
