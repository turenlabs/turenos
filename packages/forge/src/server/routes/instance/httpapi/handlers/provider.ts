import { ProviderAuth } from "@/provider/auth"
import { Auth } from "@/auth"
import { ProviderQuota } from "@/provider/quota"
import { Provider } from "@/provider/provider"

import { Duration, Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Catalog } from "@turenlabs/core/catalog"
import { Integration } from "@turenlabs/core/integration"
import { PluginV2 } from "@turenlabs/core/plugin"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { Database } from "@turenlabs/core/database/database"
import { and, gte, lte, sql } from "drizzle-orm"
import { ProviderUsageTable } from "@turenlabs/core/session/sql"

const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const credentials = yield* Auth.Service
    const { db } = yield* Database.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const plugins = yield* PluginV2.Service
      yield* plugins.wait(PluginV2.ID.make("config-provider")).pipe(Effect.catchCause(() => Effect.void))
      const catalog = yield* Catalog.Service
      const integrationsService = yield* Integration.Service
      const integrations = yield* integrationsService.list()
      const [all, available, models] = yield* Effect.all(
        [catalog.provider.all(), catalog.provider.available(), SessionRunnerModel.available()],
        { concurrency: "unbounded" },
      )
      const integrationByID = new Map(integrations.map((item) => [item.id, item]))
      const modelsByProvider = Map.groupBy(
        models.filter((model) => model.status !== "deprecated"),
        (model) => model.providerID,
      )
      const providers = all.map((item) =>
        Provider.fromCatalogProvider(
          item,
          modelsByProvider.get(item.id) ?? [],
          integrationByID.get(item.integrationID ?? Integration.ID.make(item.id)),
        ),
      )
      const defaults: Record<string, string> = {}
      for (const model of models) {
        if (model.status === "deprecated" || !model.enabled || defaults[model.providerID]) continue
        defaults[model.providerID] = model.id
      }
      return {
        all: providers,
        default: defaults,
        connected: available.map((item) => item.id),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const activity = yield* Effect.cachedWithTTL(
      Effect.gen(function* () {
        const end = Date.now()
        const start = end - USAGE_WINDOW_MS
        const rows = yield* Database.primary(db)
          .select({
            providerID: ProviderUsageTable.provider_id,
            turns: sql<number>`count(*)`,
            cost: sql<number>`coalesce(sum(${ProviderUsageTable.cost}), 0)`,
            input: sql<number>`coalesce(sum(${ProviderUsageTable.tokens_input}), 0)`,
            output: sql<number>`coalesce(sum(${ProviderUsageTable.tokens_output}), 0)`,
            reasoning: sql<number>`coalesce(sum(${ProviderUsageTable.tokens_reasoning}), 0)`,
            cacheRead: sql<number>`coalesce(sum(${ProviderUsageTable.tokens_cache_read}), 0)`,
            cacheWrite: sql<number>`coalesce(sum(${ProviderUsageTable.tokens_cache_write}), 0)`,
          })
          .from(ProviderUsageTable)
          .where(and(gte(ProviderUsageTable.time, start), lte(ProviderUsageTable.time, end)))
          .groupBy(ProviderUsageTable.provider_id)
          .all()
          .pipe(Effect.orDie)
        return {
          start,
          end,
          providers: rows
            .map((row) => ({
              providerID: ProviderV2.ID.make(row.providerID),
              turns: tokens(row.turns),
              cost: finite(row.cost),
              tokens: {
                input: tokens(row.input),
                output: tokens(row.output),
                reasoning: tokens(row.reasoning),
                cache: { read: tokens(row.cacheRead), write: tokens(row.cacheWrite) },
              },
            }))
            .toSorted((a, b) => a.providerID.localeCompare(b.providerID)),
        }
      }),
      Duration.minutes(1),
    )

    const usage = Effect.fn("ProviderHttpApi.usage")(function* () {
      const quotas = Effect.gen(function* () {
        const [connected, stored] = yield* Effect.all([provider.list(), credentials.all().pipe(Effect.orDie)], {
          concurrency: "unbounded",
        })
        // `snapshot`, not `load`: the response must not be held open for an
        // OAuth refresh or a `claude -p` process. A provider with nothing cached
        // yet is omitted rather than waited on, and the client renders it as
        // still loading until its next poll fills it in.
        const loaded = yield* Effect.all(
          Object.values(connected).map((info) =>
            ProviderQuota.snapshot(info, stored[info.id], (next) =>
              credentials.get(info.id).pipe(
                Effect.flatMap((current) => {
                  const previous = stored[info.id]
                  // A background refresh started before OAuth was re-authorized
                  // must not put its old account back after the callback won.
                  if (previous?.type !== "oauth" || current?.type !== "oauth" || current.refresh !== previous.refresh)
                    return Effect.void
                  return credentials.set(info.id, next)
                }),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        )
        return loaded.filter((quota) => quota !== undefined)
      })
      const [observed, limits] = yield* Effect.all([activity, quotas], { concurrency: "unbounded" })
      return { ...observed, quotas: limits }
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("usage", usage)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)

function finite(value: number) {
  if (Number.isNaN(value) || value <= 0) return 0
  return Math.min(Number.MAX_VALUE, value)
}

function tokens(value: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(finite(value)))
}
