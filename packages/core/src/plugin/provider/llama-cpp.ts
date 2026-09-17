import { Effect, Schema, type Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import type { PluginInternal } from "../internal"
import { normalizeLocalHttpEndpoint } from "./local-endpoint"

const PROVIDER_ID = ProviderV2.ID.make("llama-cpp")
const DEFAULT_ENDPOINT = "http://127.0.0.1:8080"
const DEFAULT_CONTEXT = 32_768
const DEFAULT_OUTPUT = 8_192
const DISCOVERY_INTERVAL = "10 seconds"

class LlamaCppModel extends Schema.Class<LlamaCppModel>("LlamaCppModel")({
  id: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Finite),
}) {}

class LlamaCppModels extends Schema.Class<LlamaCppModels>("LlamaCppModels")({
  data: Schema.Array(LlamaCppModel),
}) {}

class LlamaCppProps extends Schema.Class<LlamaCppProps>("LlamaCppProps")({
  default_generation_settings: Schema.optional(
    Schema.Struct({
      n_ctx: Schema.optional(Schema.Finite),
    }),
  ),
}) {}

export function normalizeLlamaCppEndpoint(value: unknown) {
  return normalizeLocalHttpEndpoint(value, DEFAULT_ENDPOINT)
}

export const LlamaCppPlugin = {
  id: "llama-cpp",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const endpoint = normalizeLlamaCppEndpoint(
      configuredEndpoint(yield* config.entries()) ?? process.env.LLAMA_CPP_HOST ?? DEFAULT_ENDPOINT,
    )
    if (!endpoint) return

    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    let discovered = yield* discover(http, endpoint)

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        if (!discovered) return
        catalog.provider.update(PROVIDER_ID, (provider) => {
          provider.name = "llama.cpp"
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${endpoint}/v1`,
          }
          provider.request.body.apiKey = "llamacpp"
        })

        const context = discovered.context ?? DEFAULT_CONTEXT
        for (const item of discovered.models) {
          catalog.model.update(PROVIDER_ID, ModelV2.ID.make(item.id), (model) => {
            model.name = item.id
            model.api = {
              id: ModelV2.ID.make(item.id),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `${endpoint}/v1`,
            }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            model.limit = { context, output: Math.min(DEFAULT_OUTPUT, context) }
            model.status = "active"
            model.time.released = item.model.created ? item.model.created * 1000 : 0
            model.enabled = true
          })
        }
      }),
    )

    yield* Effect.sleep(DISCOVERY_INTERVAL).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const next = yield* discover(http, endpoint)
          if (signature(next) === signature(discovered)) return
          // A failed probe is a state change too: a server that stops answering
          // must drop out of the catalog, not stay listed as connected forever.
          discovered = next
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

const discover = Effect.fnUntraced(function* (http: HttpClient.HttpClient, endpoint: string) {
  const get = (path: string) =>
    HttpClientRequest.get(`${endpoint}${path}`).pipe(
      http.execute,
      Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(undefined) }),
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    )
  const response = yield* get("/v1/models")
  if (!response) return undefined
  const list = yield* HttpClientResponse.schemaBodyJson(LlamaCppModels)(response).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (!list) return undefined
  const models = list.data.flatMap((model) => {
    const id = modelID(model)
    return id ? [{ model, id }] : []
  })
  if (models.length !== list.data.length) return undefined

  const propsResponse = yield* get("/props")
  const props = propsResponse
    ? yield* HttpClientResponse.schemaBodyJson(LlamaCppProps)(propsResponse).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
    : undefined
  const context = props?.default_generation_settings?.n_ctx
  return { models, context }
})

function modelID(model: LlamaCppModel) {
  if (typeof model.id !== "string") return undefined
  const normalized = model.id.trim()
  if (!normalized) return undefined
  if (normalized === "__proto__" || normalized === "constructor" || normalized === "prototype") return undefined
  return normalized
}

// Unreachable and reachable-with-no-models are different states: the first removes the
// provider from the catalog, the second registers it with an empty model list.
function signature(discovered: { models: readonly { readonly model: LlamaCppModel; readonly id: string }[]; context?: number } | undefined) {
  if (discovered === undefined) return "unreachable"
  return JSON.stringify([discovered.models.map((item) => item.id), discovered.context])
}
