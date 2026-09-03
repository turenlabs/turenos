export * as AISDK from "./aisdk"

import { makeLocationNode } from "./effect/app-node"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Cause, Context, Effect, Layer, Schema, Scope } from "effect"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { State } from "./state"

type SDK = any

// OAuth routing is deliberately carried out of band. Keeping this marker off
// ModelV2.Info.request.body means it cannot become an AI SDK provider option or
// part of an upstream request body when the model is bridged.
const xaiOAuthModels = new WeakSet<ModelV2.Info>()

export const markXaiOAuthModel = (model: ModelV2.Info) => {
  xaiOAuthModels.add(model)
  return model
}

export const isXaiOAuthModel = (model: object) => xaiOAuthModels.has(model as ModelV2.Info)

export interface SDKEvent {
  readonly model: ModelV2.Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: ModelV2.Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new Error("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function prepareOptions(model: ModelV2.Info, pkg: string) {
  const options: Record<string, any> = {
    name: model.providerID,
    ...(model.api.type === "aisdk" ? (model.api.settings ?? {}) : {}),
    ...model.request.body,
  }
  if (model.api.type === "aisdk" && model.api.url) options.baseURL = model.api.url

  const customFetch = options.fetch
  const chunkTimeout = options.chunkTimeout
  delete options.chunkTimeout
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const opts = { ...(init ?? {}) }
    const signals = [
      opts.signal,
      typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined,
      options.timeout !== undefined && options.timeout !== null && options.timeout !== false
        ? AbortSignal.timeout(options.timeout)
        : undefined,
    ].filter((item): item is AbortSignal | AbortController => Boolean(item))
    const chunkAbortCtl = signals.find((item): item is AbortController => item instanceof AbortController)
    const abortSignals = signals.map((item) => (item instanceof AbortController ? item.signal : item))
    if (abortSignals.length === 1) opts.signal = abortSignals[0]
    if (abortSignals.length > 1) opts.signal = AbortSignal.any(abortSignals)

    if (
      (pkg === "@ai-sdk/openai" || pkg === "@ai-sdk/azure" || pkg === "@ai-sdk/amazon-bedrock/mantle") &&
      opts.body &&
      opts.method === "POST"
    ) {
      const body = JSON.parse(opts.body as string)
      if (body.store !== true && Array.isArray(body.input)) {
        for (const item of body.input) {
          if ("id" in item) delete item.id
        }
        opts.body = JSON.stringify(body)
      }
    }

    const res = await (typeof customFetch === "function" ? customFetch : fetch)(input, {
      ...opts,
      timeout: false,
    })
    if (!chunkAbortCtl || typeof chunkTimeout !== "number") return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

const cacheFingerprint = (model: ModelV2.Info) =>
  Effect.promise(async () => {
    const encoded = JSON.stringify(
      {
        api: model.api,
        headers: model.request.headers,
        body: model.request.body,
        xaiOAuth: isXaiOAuthModel(model),
      },
      (_, value) => (typeof value === "function" ? `[function:${value.name || "anonymous"}]` : value),
    )
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
  })

export class InitError extends Schema.TaggedErrorClass<InitError>()("AISDK.InitError", {
  providerID: ProviderV2.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: ProviderV2.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: ModelV2.Info) => Effect.Effect<LanguageModelV3, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, { readonly fingerprint: string; readonly language: LanguageModelV3 }>()
    const sdks = new Map<string, { readonly fingerprint: string; readonly sdk: SDK }>()

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const fingerprint = yield* cacheFingerprint(model)
        const key = `${model.providerID}/${model.id}/${model.request.variant ?? "default"}`
        const existing = languages.get(key)
        if (existing?.fingerprint === fingerprint) return existing.language
        if (model.api.type !== "aisdk")
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported api ${model.api.type}`),
          })

        const options = prepareOptions(model, model.api.package)
        const sdkKey = `${model.providerID}/${model.id}/${model.api.package}/${model.request.variant ?? "default"}`
        const existingSDK = sdks.get(sdkKey)
        const sdk =
          (existingSDK?.fingerprint === fingerprint ? existingSDK.sdk : undefined) ??
          (yield* service.runSDK({ model, package: model.api.package, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, { fingerprint, sdk })
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.api.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, { fingerprint, language })
        return language
      }),
    })
    return service
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
