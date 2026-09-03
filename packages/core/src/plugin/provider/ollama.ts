import { Effect, Schema, type Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"

const PROVIDER_ID = ProviderV2.ID.make("ollama")
const DEFAULT_ENDPOINT = "http://127.0.0.1:11434"
const DEFAULT_CONTEXT = 32_768
const DEFAULT_OUTPUT = 8_192
const DISCOVERY_INTERVAL = "10 seconds"

class OllamaDetails extends Schema.Class<OllamaDetails>("OllamaDetails")({
  family: Schema.optional(Schema.String),
}) {}

class OllamaModel extends Schema.Class<OllamaModel>("OllamaModel")({
  name: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modified_at: Schema.optional(Schema.String),
  details: Schema.optional(OllamaDetails),
}) {}

class OllamaTags extends Schema.Class<OllamaTags>("OllamaTags")({
  models: Schema.Array(OllamaModel),
}) {}

export function normalizeOllamaEndpoint(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== "string") return undefined
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_ENDPOINT
  const candidate = raw.includes("://") ? raw : `http://${raw}`

  try {
    const url = new URL(candidate)
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined

    const pathname = url.pathname.replace(/\/+$/, "")
    url.pathname = pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname || "/"
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}

export const OllamaPlugin = {
  id: "ollama",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const endpoint = normalizeOllamaEndpoint(
      configuredEndpoint(yield* config.entries()) ?? process.env.OLLAMA_HOST ?? DEFAULT_ENDPOINT,
    )
    if (!endpoint) return

    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    let models = yield* discover(http, endpoint)

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        if (!models?.length) return
        catalog.provider.update(PROVIDER_ID, (provider) => {
          provider.name = "Ollama"
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${endpoint}/v1`,
          }
          provider.request.body.apiKey = "ollama"
        })

        for (const item of models) {
          catalog.model.update(PROVIDER_ID, ModelV2.ID.make(item.id), (model) => {
            model.name = item.id
            if (item.model.details?.family !== undefined) model.family = item.model.details.family
            model.api = {
              id: ModelV2.ID.make(item.id),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `${endpoint}/v1`,
            }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            model.limit = { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
            model.status = "active"
            model.time.released = released(item.model.modified_at)
            model.enabled = true
          })
        }
      }),
    )

    yield* Effect.sleep(DISCOVERY_INTERVAL).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const discovered = yield* discover(http, endpoint)
          if (!discovered || signature(discovered) === signature(models)) return
          models = discovered
          yield* ctx.catalog.reload()
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
  }),
} satisfies PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>

function configuredEndpoint(entries: readonly Config.Entry[]) {
  return entries
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => {
      const provider = entry.info.providers?.[PROVIDER_ID]
      if (!provider) return []
      const baseURL = provider.request?.body?.baseURL
      if (typeof baseURL === "string") return [baseURL]
      return provider.api?.url ? [provider.api.url] : []
    })
    .at(-1)
}

function modelID(model: OllamaModel) {
  const id = [model.name, model.model].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  )
  if (!id) return undefined
  const normalized = id.trim()
  if (normalized === "__proto__" || normalized === "constructor" || normalized === "prototype") return undefined
  return normalized
}

const discover = Effect.fnUntraced(function* (http: HttpClient.HttpClient, endpoint: string) {
  const tags = yield* HttpClientRequest.get(`${endpoint}/api/tags`).pipe(
    http.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaTags)),
    Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(undefined) }),
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  )
  if (!tags) return undefined
  const models = tags.models.flatMap((model) => {
    const id = modelID(model)
    return id ? [{ model, id }] : []
  })
  if (models.length !== tags.models.length) return undefined
  return models
})

function signature(models: readonly { readonly model: OllamaModel; readonly id: string }[] | undefined) {
  return JSON.stringify(models?.map((item) => [item.id, item.model.modified_at, item.model.details?.family]) ?? [])
}

function released(value: string | undefined) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}
