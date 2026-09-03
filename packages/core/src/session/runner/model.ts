export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { Model, ModelCompatibility, type ProviderMetadata } from "@turenlabs/llm"
import { AnthropicMessages } from "@turenlabs/llm/protocols/anthropic-messages"
import { Gemini } from "@turenlabs/llm/protocols/gemini"
import { OpenAICompatibleChat } from "@turenlabs/llm/protocols/openai-compatible-chat"
import { OpenAIResponses } from "@turenlabs/llm/protocols/openai-responses"
import { AmazonBedrock, Azure, OpenRouter, XAI } from "@turenlabs/llm/providers"
import { Auth, type AnyRoute } from "@turenlabs/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { AISDK, markXaiOAuthModel } from "../../aisdk"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { AmazonBedrockModel } from "../../plugin/provider/amazon-bedrock-model"
import { OpenAICodex } from "../../plugin/provider/openai-codex"
import { ProviderV2 } from "../../provider"
import { AISDKBridge } from "./aisdk-bridge"
import { ClaudeCodeBridge } from "./claude-code-bridge"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    /** Why the model could not be resolved, so a catalog mismatch never reads as a config typo. */
    reason: Schema.optional(Schema.String),
  },
) {
  override get message() {
    const suffix = this.reason === undefined ? "" : ` (${this.reason})`
    return `Model unavailable: ${this.providerID}/${this.modelID}${suffix}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export class ProviderConfigurationError extends Schema.TaggedErrorClass<ProviderConfigurationError>()(
  "SessionRunnerModel.ProviderConfigurationError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Provider configuration unavailable for ${this.providerID}/${this.modelID}: ${this.reason}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | ProviderConfigurationError
  | Integration.AuthorizationError

export type Resolved = {
  readonly model: Model
  readonly ref: ModelV2.Ref
  /**
   * The catalog's price list for the resolved model, carried so the runner can
   * settle a turn's cost without depending on `Catalog.node`. Everything else
   * about `ModelV2.Info` is deliberately left behind -- `ref` is the identity
   * the transcript records, and pricing is the one other fact a completed turn
   * needs. Empty for a model the catalog has no pricing for.
   */
  readonly cost: ReadonlyArray<Cost>
}

/** `ModelV2` re-exports the `Cost` schema but not its type; this is that type. */
type Cost = typeof ModelV2.Cost.Type

/**
 * The price list entry that applies to a request of this size.
 *
 * The catalog stores `Cost[]` as an untiered base entry followed by zero or
 * more context tiers (`packages/core/src/plugin/models-dev.ts`), where
 * `tier.size` is a threshold the request must strictly exceed. The highest
 * matching tier wins; with none matching, the untiered base does. Rewritten
 * rather than ported from V1's nested `{tiers, experimentalOver200K}` shape,
 * which no longer exists here -- models.dev's legacy `context_over_200k` is
 * already flattened into a `tier: {type: "context", size: 200_000}` entry
 * upstream of this function.
 */
const tierFor = (costs: ReadonlyArray<Cost>, contextTokens: number) => {
  let best: Cost | undefined
  let base: Cost | undefined
  for (const entry of costs) {
    if (entry.tier === undefined) {
      base ??= entry
      continue
    }
    if (entry.tier.type !== "context" || contextTokens <= entry.tier.size) continue
    if (best?.tier === undefined || entry.tier.size > best.tier.size) best = entry
  }
  return best ?? base
}

const rate = (tokens: number, price: number) => tokens * (Number.isFinite(price) ? price : 0)

/**
 * Structural on purpose: both the occupancy and the cumulative record a settled
 * turn carries have this shape, and stating it here keeps the price list free
 * of any dependency on the runner's publisher.
 */
type SettledTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/**
 * What a settled turn cost, in dollars.
 *
 * Occupancy and cumulative usage both appear here, and each answers the
 * question it is fit for. `settlement.tokens` -- one request's context
 * occupancy -- picks the price tier, because a tier is a statement about how
 * large a single prompt was. `settlement.processed` -- the whole turn -- is
 * what gets multiplied, because every request behind the turn was charged for.
 * Using occupancy as the multiplicand would undercount a looping transport to
 * its last round trip; using the cumulative figure to pick the tier would
 * promote a long turn into a tier no single request ever reached.
 *
 * Plain floating point rather than V1's `Decimal`: the expression is five
 * products and one division, so the relative error is ~1e-16 -- some fourteen
 * orders of magnitude below a cent -- and `decimal.js` is not a dependency of
 * this package.
 */
export const cost = (
  resolved: Pick<Resolved, "cost">,
  settlement: {
    readonly tokens: SettledTokens
    readonly processed: SettledTokens
    readonly metadata?: ProviderMetadata
  },
) => {
  // A provider-authoritative charge beats anything derived from token counts.
  // GitHub Copilot bills in nano-AIU; 1e11 nano-AIU is one dollar.
  //
  // The Claude Code bridge's `claudeCode.totalCostUsd` is deliberately *not*
  // read here. It is what the run would have cost on the API, but the transport
  // is billed against a subscription -- which is why its catalog entry carries
  // an empty price list (`plugin/provider/claude-code.ts`). Counting it would
  // report money the user never spent.
  const nanoAiu = settlement.metadata?.["copilot"]?.["totalNanoAiu"]
  if (typeof nanoAiu === "number" && Number.isFinite(nanoAiu) && nanoAiu >= 0) return nanoAiu / 100_000_000_000

  const occupancy = settlement.tokens
  const tier = tierFor(resolved.cost, occupancy.input + occupancy.cache.read + occupancy.cache.write)
  if (!tier) return 0
  const billed = settlement.processed
  const total =
    rate(billed.input, tier.input) +
    rate(billed.output, tier.output) +
    rate(billed.cache.read, tier.cache.read) +
    rate(billed.cache.write, tier.cache.write) +
    // models.dev has no separate reasoning rate; V1 charged reasoning at the
    // output rate and this keeps that.
    rate(billed.reasoning, tier.output)
  const value = total / 1_000_000
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * The billing half of `Step.Ended`, ready to spread into the event.
 *
 * Kept as one call so the two fields that have to agree -- the charge and the
 * token counts it was derived from -- cannot drift apart at the call site.
 * `tokens` is published alongside and separately: it is occupancy, not billing.
 */
export const settle = (
  resolved: Pick<Resolved, "cost">,
  settlement: {
    readonly tokens: SettledTokens
    readonly processed: SettledTokens
    readonly metadata?: ProviderMetadata
  },
) => ({ cost: cost(resolved, settlement), billed: settlement.processed })

export interface Interface {
  readonly resolve: (session: SessionSchema.Info, request?: ProviderV2.Request) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const secret = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return credential.key
  if (credential?.type === "oauth") return credential.access
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return value
}

const numberOption = (body: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  return keys.map((key) => body[key]).find((item): item is number => typeof item === "number")
}

const stringOption = (body: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  return keys.map((key) => body[key]).find((item): item is string => typeof item === "string")
}

const recordOption = (body: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  return keys
    .map((key) => body[key])
    .find((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
}

const stringArrayOption = (body: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  for (const key of keys) {
    const value = body[key]
    if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return value
  }
}

const REQUEST_CONTROL_KEYS = new Set([
  "accessKeyId",
  "apiKey",
  "apiVersion",
  "auth",
  "baseURL",
  "bearerToken",
  "chunkTimeout",
  "credentialProvider",
  "endpoint",
  "fetch",
  "gateway",
  "gatewayId",
  "profile",
  "region",
  "resourceName",
  "secretAccessKey",
  "sessionToken",
  "timeout",
  "useCompletionUrls",
])

const GENERATION_KEYS = new Set([
  "frequencyPenalty",
  "frequency_penalty",
  "maxOutputTokens",
  "maxTokens",
  "max_output_tokens",
  "max_tokens",
  "presencePenalty",
  "presence_penalty",
  "seed",
  "stop",
  "stopSequences",
  "stop_sequences",
  "temperature",
  "topK",
  "topP",
  "top_k",
  "top_p",
])

const OPENAI_OPTION_KEYS = new Set([
  "include",
  "instructions",
  "promptCacheKey",
  "prompt_cache_key",
  "reasoning",
  "reasoningEffort",
  "reasoningContext",
  "reasoningMode",
  "reasoningSummary",
  "reasoning_context",
  "reasoning_effort",
  "reasoning_mode",
  "reasoning_summary",
  "serviceTier",
  "service_tier",
  "store",
  "textVerbosity",
  "text_verbosity",
])

const DIRECT_ADAPTER_PACKAGES = new Set([
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/google",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/xai",
  "@openrouter/ai-sdk-provider",
])

const providerOptionKey = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return model.providerID
  if (model.api.package === "@ai-sdk/github-copilot") return "copilot"
  if (model.api.package === "@ai-sdk/azure") return "azure"
  if (model.api.package === "@ai-sdk/openai" || model.api.package === "@ai-sdk/amazon-bedrock/mantle") return "openai"
  if (model.api.package === "@ai-sdk/amazon-bedrock") return "bedrock"
  if (model.api.package === "@ai-sdk/anthropic" || model.api.package === "@ai-sdk/google-vertex/anthropic")
    return "anthropic"
  if (model.api.package === "@ai-sdk/google-vertex") return "vertex"
  if (model.api.package === "@ai-sdk/google") return "google"
  if (model.api.package === "@ai-sdk/gateway") return "gateway"
  if (model.api.package === "@openrouter/ai-sdk-provider") return "openrouter"
  if (model.api.package === "ai-gateway-provider") return "openaiCompatible"
  if (
    model.api.package === "@ai-sdk/openai-compatible" ||
    model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic"
  )
    return model.providerID.split(".")[0]!
  return model.providerID
}

const scopedProviderOptions = (
  model: ModelV2.Info,
  options: Record<string, unknown>,
): Record<string, Record<string, unknown>> => {
  if (model.api.type !== "aisdk") return {}
  if (model.api.package === "@ai-sdk/gateway") {
    const upstream = model.api.id.includes("/") ? model.api.id.slice(0, model.api.id.indexOf("/")) : undefined
    const slug = upstream === "amazon" ? "bedrock" : upstream
    const gateway = recordOption(model.request.body, "gateway")
    return {
      ...(gateway ? { gateway } : {}),
      ...(Object.keys(options).length === 0
        ? {}
        : slug
          ? { [slug]: options }
          : { gateway: { ...(gateway ?? {}), ...options } }),
    }
  }
  if (Object.keys(options).length === 0) return {}
  if (model.api.package === "@ai-sdk/azure") return { openai: options, azure: options }
  return { [providerOptionKey(model)]: options }
}

const requestDefaults = (model: ModelV2.Info) => {
  const body = model.request.body
  const packageName = model.api.type === "aisdk" ? model.api.package : undefined
  const usesAnthropicOptions = packageName === "@ai-sdk/anthropic" || packageName === "@ai-sdk/google-vertex/anthropic"
  const usesGeminiOptions = packageName === "@ai-sdk/google" || packageName === "@ai-sdk/google-vertex"
  const usesOpenAIOptions =
    packageName === "@ai-sdk/openai" || packageName === "@ai-sdk/azure" || packageName === "@ai-sdk/xai"
  const stop = stringArrayOption(body, "stop", "stopSequences", "stop_sequences")
  const generation = {
    maxTokens: numberOption(body, "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens"),
    temperature: numberOption(body, "temperature"),
    topP: numberOption(body, "topP", "top_p"),
    topK: numberOption(body, "topK", "top_k"),
    frequencyPenalty: numberOption(body, "frequencyPenalty", "frequency_penalty"),
    presencePenalty: numberOption(body, "presencePenalty", "presence_penalty"),
    seed: numberOption(body, "seed"),
    stop,
  }
  const reasoning = recordOption(body, "reasoning")
  const openai = {
    store: typeof body.store === "boolean" ? body.store : undefined,
    promptCacheKey: stringOption(body, "promptCacheKey", "prompt_cache_key"),
    reasoningEffort:
      stringOption(body, "reasoningEffort", "reasoning_effort") ??
      (typeof reasoning?.effort === "string" ? reasoning.effort : undefined),
    reasoningSummary:
      stringOption(body, "reasoningSummary", "reasoning_summary") ??
      (typeof reasoning?.summary === "string" ? reasoning.summary : undefined),
    reasoningMode:
      stringOption(body, "reasoningMode", "reasoning_mode") ??
      (typeof reasoning?.mode === "string" ? reasoning.mode : undefined),
    reasoningContext:
      stringOption(body, "reasoningContext", "reasoning_context") ??
      (typeof reasoning?.context === "string" ? reasoning.context : undefined),
    include: stringArrayOption(body, "include"),
    textVerbosity: stringOption(body, "textVerbosity", "text_verbosity"),
    serviceTier: stringOption(body, "serviceTier", "service_tier"),
    instructions: stringOption(body, "instructions"),
  }
  const packageOptions = usesAnthropicOptions
    ? {
        thinking: body.thinking,
        effort: stringOption(body, "effort") ?? stringOption(recordOption(body, "output_config") ?? {}, "effort"),
      }
    : usesGeminiOptions
      ? { thinkingConfig: body.thinkingConfig ?? body.thinking_config }
      : usesOpenAIOptions
        ? openai
        : {}
  const providerKeys = usesAnthropicOptions
    ? new Set(["thinking", "effort"])
    : usesGeminiOptions
      ? new Set(["thinkingConfig", "thinking_config"])
      : usesOpenAIOptions
        ? OPENAI_OPTION_KEYS
        : new Set<string>()
  const httpBody = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => !REQUEST_CONTROL_KEYS.has(key) && !GENERATION_KEYS.has(key) && !providerKeys.has(key),
    ),
  )
  const definedGeneration = Object.fromEntries(Object.entries(generation).filter(([, value]) => value !== undefined))
  const providerOptions = scopedProviderOptions(model, {
    ...(packageName && !DIRECT_ADAPTER_PACKAGES.has(packageName) ? httpBody : {}),
    ...Object.fromEntries(Object.entries(packageOptions).filter(([, value]) => value !== undefined)),
  })
  return {
    generation: Object.keys(definedGeneration).length === 0 ? undefined : definedGeneration,
    providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
    http: { body: httpBody },
  }
}

const defaults = (model: ModelV2.Info) => {
  const request = requestDefaults(model)
  return {
    provider: model.providerID,
    headers: model.request.headers,
    ...request,
    ...(model.providerID === ProviderV2.ID.make("ollama")
      ? { http: { ...request.http, redirect: "error" as const } }
      : {}),
    limits: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
  }
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) =>
  route.with({
    ...defaults(model),
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
  })

/**
 * Applies a session's variant to the model this runtime actually publishes.
 *
 * A variant selection is sticky: it survives model switches and outlives the catalog that
 * offered it, so by the time a turn runs the stored id routinely names a variant the
 * selected model has never published. That is not a request the user is making now, and
 * failing the turn over it strands the session permanently — every later prompt replays
 * the same error until someone edits stored state. Fall back to the model's own default
 * instead, and report only the variant that was actually applied so the resolved ref never
 * claims one that was not.
 */
const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
  request?: ProviderV2.Request,
): { readonly model: ModelV2.Info; readonly variant?: ModelV2.VariantID } => {
  const published = (id: string | undefined) =>
    id === undefined ? undefined : model.variants.find((item) => item.id === id)
  const requested = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = published(requested) ?? published(model.request.variant)
  return {
    model:
      variant || request
        ? produce(model, (draft) => {
            if (variant) {
              mergeInto(draft.request.headers, variant.headers)
              mergeInto(draft.request.body, variant.body)
            }
            if (request) {
              mergeInto(draft.request.headers, request.headers)
              mergeInto(draft.request.body, request.body)
            }
          })
        : model,
    variant: variant?.id,
  }
}

/**
 * Merges provider/variant overrides into a request draft. Skips prototype-mutating keys so a
 * hostile catalog entry or agent-supplied override cannot pollute Object.prototype.
 */
const mergeInto = (target: Record<string, unknown>, source: Record<string, unknown> | undefined) => {
  if (!source) return
  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    target[key] = value
  }
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

type Adapter = {
  readonly resolve: (
    model: ModelV2.Info,
    credential?: Credential.Value,
  ) => Effect.Effect<Model, ProviderConfigurationError>
}

const canonicalProvider = new Map<string, ReadonlySet<string>>([
  ["@ai-sdk/amazon-bedrock", new Set([ProviderV2.ID.amazonBedrock])],
  ["@ai-sdk/anthropic", new Set([ProviderV2.ID.anthropic])],
  ["@ai-sdk/azure", new Set([ProviderV2.ID.azure])],
  ["@ai-sdk/google", new Set([ProviderV2.ID.google])],
  ["@ai-sdk/openai", new Set([ProviderV2.ID.openai])],
  ["@ai-sdk/xai", new Set([ProviderV2.ID.make("xai")])],
  ["@openrouter/ai-sdk-provider", new Set([ProviderV2.ID.openrouter])],
])

const bridgeProvider = new Map<string, ReadonlySet<string>>([
  ["@ai-sdk/alibaba", new Set(["alibaba"])],
  ["@ai-sdk/amazon-bedrock", new Set([ProviderV2.ID.amazonBedrock])],
  ["@ai-sdk/amazon-bedrock/mantle", new Set([ProviderV2.ID.amazonBedrock])],
  ["@ai-sdk/anthropic", new Set([ProviderV2.ID.anthropic])],
  ["@ai-sdk/azure", new Set([ProviderV2.ID.azure, ProviderV2.ID.make("azure-cognitive-services")])],
  ["@ai-sdk/cerebras", new Set(["cerebras"])],
  ["@ai-sdk/cohere", new Set(["cohere"])],
  ["@ai-sdk/deepinfra", new Set(["deepinfra"])],
  ["@ai-sdk/gateway", new Set(["gateway", "vercel"])],
  ["@ai-sdk/google", new Set([ProviderV2.ID.google])],
  ["@ai-sdk/google-vertex", new Set([ProviderV2.ID.googleVertex])],
  [
    "@ai-sdk/google-vertex/anthropic",
    new Set([ProviderV2.ID.googleVertex, ProviderV2.ID.make("google-vertex-anthropic")]),
  ],
  ["@ai-sdk/groq", new Set(["groq"])],
  ["@ai-sdk/mistral", new Set([ProviderV2.ID.mistral])],
  ["@ai-sdk/openai", new Set([ProviderV2.ID.openai])],
  ["@ai-sdk/perplexity", new Set(["perplexity"])],
  ["@ai-sdk/togetherai", new Set(["togetherai"])],
  ["@ai-sdk/vercel", new Set(["vercel", "v0"])],
  ["@ai-sdk/xai", new Set(["xai"])],
  ["@openrouter/ai-sdk-provider", new Set([ProviderV2.ID.openrouter])],
  ["@aihubmix/ai-sdk-provider", new Set(["aihubmix"])],
  ["ai-gateway-provider", new Set(["cloudflare-ai-gateway"])],
  ["gitlab-ai-provider", new Set([ProviderV2.ID.gitlab])],
  ["merge-gateway-ai-sdk-provider", new Set(["merge-gateway"])],
  ["venice-ai-sdk-provider", new Set(["venice"])],
])

const qualifiedURL = (value: string | undefined) => {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password || url.hash) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") return true
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return false
  const octets = url.hostname.split(".").map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

const qualifiedProviderURL = (model: ModelV2.Info, value: string | undefined) => {
  if (!qualifiedURL(value) || value === undefined) return false
  const hostname = new URL(value).hostname
  if (model.providerID === ProviderV2.ID.make("cloudflare-ai-gateway"))
    return hostname === "cloudflare.com" || hostname.endsWith(".cloudflare.com")
  if (model.providerID === ProviderV2.ID.githubCopilot)
    return (
      hostname === "github.com" ||
      hostname.endsWith(".github.com") ||
      hostname === "githubcopilot.com" ||
      hostname.endsWith(".githubcopilot.com")
    )
  return true
}

const nativeQualified = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return false
  if (model.api.url !== undefined) return qualifiedProviderURL(model, model.api.url)
  if (!canonicalProvider.get(model.api.package)?.has(model.providerID)) return false
  if (model.api.package !== "@ai-sdk/azure") return true
  return typeof model.request.body.resourceName === "string" && model.request.body.resourceName.trim().length > 0
}

const configuredBaseURL = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return undefined
  if (model.api.url !== undefined) return model.api.url
  const request = model.request.body.baseURL
  if (typeof request === "string") return request
  const setting = model.api.settings?.baseURL
  return typeof setting === "string" ? setting : undefined
}

const azureCognitiveBaseURL = (resourceName: unknown) => {
  if (typeof resourceName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(resourceName)) return
  return `https://${resourceName}.cognitiveservices.azure.com/openai`
}

const bridgeQualified = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return false
  const baseURL = configuredBaseURL(model)
  if (baseURL !== undefined) return qualifiedProviderURL(model, baseURL)
  if (bridgeProvider.get(model.api.package)?.has(model.providerID)) return true
  return model.providerID === ProviderV2.ID.make("sap-ai-core")
}

const requireDirectCredential = (
  model: ModelV2.Info,
  credential: Credential.Value | undefined,
): Effect.Effect<void, ProviderConfigurationError> => {
  if (credential?.type !== "oauth") return Effect.void
  return Effect.fail(
    new ProviderConfigurationError({
      providerID: model.providerID,
      modelID: model.id,
      reason:
        model.providerID === ProviderV2.ID.openai
          ? "ChatGPT OAuth cannot be sent to the public OpenAI API"
          : "OAuth credentials require a qualified AI SDK provider route",
    }),
  )
}

const credentialConfiguration = (model: ModelV2.Info, credential: Credential.Value | undefined) => {
  if (credential?.type !== "key" || credential.metadata === undefined || model.api.type !== "aisdk") return model
  const allowed =
    model.api.package === "@ai-sdk/azure"
      ? new Set(["apiVersion", "resourceName", "useCompletionUrls"])
      : model.api.package === "@ai-sdk/amazon-bedrock"
        ? new Set(["accessKeyId", "profile", "region", "secretAccessKey", "sessionToken"])
        : new Set<string>()
  const metadata = Object.fromEntries(Object.entries(credential.metadata).filter(([key]) => allowed.has(key)))
  if (Object.keys(metadata).length === 0) return model
  return produce(model, (draft) => {
    Object.assign(draft.request.body, metadata)
  })
}

const bridgeCredentialConfiguration = (model: ModelV2.Info, credential: Credential.Value | undefined) => {
  if (model.api.type !== "aisdk") return model
  const packageName = model.api.package
  const allowed =
    packageName === "ai-gateway-provider"
      ? new Set(["accountId", "gateway", "gatewayId"])
      : packageName === "@ai-sdk/azure"
        ? new Set(["apiVersion", "resourceName", "useCompletionUrls"])
        : packageName === "@ai-sdk/amazon-bedrock" || packageName === "@ai-sdk/amazon-bedrock/mantle"
          ? new Set(["accessKeyId", "profile", "region", "secretAccessKey", "sessionToken"])
          : packageName.startsWith("@ai-sdk/google-vertex")
            ? new Set(["location", "project"])
            : new Set<string>()
  const metadata =
    credential?.type === "key" && credential.metadata
      ? Object.fromEntries(Object.entries(credential.metadata).filter(([key]) => allowed.has(key)))
      : {}
  const configured = produce(model, (draft) => {
    if (credential?.type === "key") draft.request.body.apiKey = credential.key
    if (credential?.type === "oauth") draft.request.body.apiKey = credential.access
    Object.assign(draft.request.body, metadata)
    const baseURL = configuredBaseURL(model)
    if (baseURL !== undefined) draft.request.body.baseURL = baseURL
    if (
      model.providerID === ProviderV2.ID.make("azure-cognitive-services") &&
      packageName === "@ai-sdk/azure" &&
      baseURL === undefined
    ) {
      const cognitiveBaseURL = azureCognitiveBaseURL(
        process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME ?? draft.request.body.resourceName,
      )
      if (cognitiveBaseURL) draft.request.body.baseURL = cognitiveBaseURL
    }
  })
  if (credential?.type === "oauth" && model.providerID === ProviderV2.ID.make("xai") && packageName === "@ai-sdk/xai")
    return markXaiOAuthModel(configured)
  return configured
}

const bridgeConfiguration = (
  model: ModelV2.Info,
  credential: Credential.Value | undefined,
): Effect.Effect<void, ProviderConfigurationError> => {
  if (model.providerID === ProviderV2.ID.openai && credential?.type === "oauth")
    return Effect.fail(
      new ProviderConfigurationError({
        providerID: model.providerID,
        modelID: model.id,
        reason: "ChatGPT OAuth requires the Codex transport and cannot be sent to the public OpenAI API",
      }),
    )
  if (
    model.providerID === ProviderV2.ID.make("azure-cognitive-services") &&
    model.api.type === "aisdk" &&
    model.api.package === "@ai-sdk/azure" &&
    configuredBaseURL(model) === undefined
  )
    return Effect.fail(
      new ProviderConfigurationError({
        providerID: model.providerID,
        modelID: model.id,
        reason: "Azure Cognitive Services requires a qualified resource endpoint",
      }),
    )
  if (model.api.type !== "aisdk" || model.api.package !== "ai-gateway-provider") return Effect.void
  const metadata = credential?.type === "key" ? credential.metadata : undefined
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ??
    stringOption(model.request.body, "accountId") ??
    stringOption(model.api.settings ?? {}, "accountId") ??
    (metadata ? stringOption(metadata, "accountId") : undefined)
  const gatewayId =
    process.env.CLOUDFLARE_GATEWAY_ID ??
    stringOption(model.request.body, "gatewayId", "gateway") ??
    stringOption(model.api.settings ?? {}, "gatewayId", "gateway") ??
    (metadata ? stringOption(metadata, "gatewayId", "gateway") : undefined)
  if (accountId && gatewayId) return Effect.void
  return Effect.fail(
    new ProviderConfigurationError({
      providerID: model.providerID,
      modelID: model.id,
      reason: "Cloudflare AI Gateway requires accountId and gatewayId",
    }),
  )
}

const bearer = (model: ModelV2.Info, credential?: Credential.Value) => {
  const value = secret(model, credential)
  return value === undefined ? Auth.none : Auth.bearer(Auth.value(value))
}

const header = (name: string, model: ModelV2.Info, credential?: Credential.Value) => {
  const value = secret(model, credential)
  return value === undefined ? Auth.none : Auth.header(name, Auth.value(value))
}

const moonshotCompatible = (model: ModelV2.Info) =>
  model.providerID === ProviderV2.ID.make("moonshotai") ||
  model.providerID === ProviderV2.ID.make("kimi-for-coding") ||
  model.api.id.toLowerCase().includes("kimi")

// `reasoning_content` is the only echo-back field the OpenAI Chat body carries; `reasoning` and
// `reasoning_details` belong to OpenRouter, which resolves through its own adapter below.
const openAICompatibility = (model: ModelV2.Info) => {
  const compatibility = {
    ...(moonshotCompatible(model) ? { toolSchema: "moonshot" as const } : {}),
    ...(model.capabilities.interleaved?.field === "reasoning_content" ? { reasoningPassback: true } : {}),
    ...(acceptsMedia(model) ? {} : { mediaInput: false }),
  }
  return Object.keys(compatibility).length === 0 ? undefined : compatibility
}

/**
 * Merge catalog-derived OpenAI-protocol compatibility into an already-resolved model. Most adapters
 * select their route before compatibility is known, so the resolved model gets the patch here:
 * `mediaInput: false` keeps image parts off the wire for any model whose catalog does not claim
 * image input (see `acceptsMedia`), and the merge preserves adapter-set fields like
 * `maxOutputTokens: false` from the ChatGPT Codex route.
 */
const withOpenAICompatibility = (resolved: Model, model: ModelV2.Info): Model => {
  const patch = openAICompatibility(model)
  if (patch === undefined) return resolved
  const existing: ModelCompatibility | undefined = resolved.compatibility
  if (existing === undefined) return Model.update(resolved, { compatibility: patch })
  return Model.update(resolved, {
    compatibility: new ModelCompatibility({
      toolSchema: existing.toolSchema ?? patch.toolSchema,
      maxOutputTokens: existing.maxOutputTokens,
      reasoningPassback: existing.reasoningPassback ?? patch.reasoningPassback,
      mediaInput: existing.mediaInput ?? patch.mediaInput,
    }),
  })
}

/**
 * Whether the catalog says this model takes image input. Only an explicit `image` modality counts.
 * An empty modality list -- a manually configured provider, or a catalog without modalities -- is
 * text-only, not "no opinion": a text-only upstream rejects the whole request on an image part, and
 * because the attachment stays in the transcript every later turn re-sends it and fails
 * identically, so the Session can never recover on its own. A catalog author can always declare
 * `image` input to re-enable media.
 */
const acceptsMedia = (model: ModelV2.Info) => model.capabilities.input.some((item) => item.startsWith("image"))

const adapters = {
  "@ai-sdk/openai": {
    resolve: (model, credential) =>
      Effect.succeed(
        withDefaults(model, OpenAIResponses.route)
          .with({ auth: bearer(model, credential) })
          .model({ id: model.api.id, compatibility: openAICompatibility(model) }),
      ),
  },
  "@ai-sdk/anthropic": {
    resolve: (model, credential) =>
      Effect.succeed(
        withDefaults(model, AnthropicMessages.route)
          .with({ auth: header("x-api-key", model, credential) })
          .model({
            id: model.api.id,
            compatibility: moonshotCompatible(model) ? { toolSchema: "moonshot" } : undefined,
          }),
      ),
  },
  "@ai-sdk/google": {
    resolve: (model, credential) =>
      Effect.succeed(
        withDefaults(model, Gemini.route)
          .with({ auth: header("x-goog-api-key", model, credential) })
          .model({ id: model.api.id }),
      ),
  },
  "@ai-sdk/openai-compatible": {
    resolve: (model, credential) =>
      Effect.succeed(
        withDefaults(model, OpenAICompatibleChat.route)
          .with({ auth: bearer(model, credential) })
          .model({
            id: model.api.id,
            compatibility: openAICompatibility(model),
          }),
      ),
  },
  "@ai-sdk/azure": {
    resolve: (model, credential) => {
      const resourceName =
        typeof model.request.body.resourceName === "string" ? model.request.body.resourceName.trim() : undefined
      const configured =
        model.api.url === undefined
          ? {
              ...defaults(model),
              resourceName: resourceName!,
              apiKey: secret(model, credential),
              apiVersion: stringOption(model.request.body, "apiVersion"),
              useCompletionUrls: model.request.body.useCompletionUrls === true,
            }
          : {
              ...defaults(model),
              baseURL: model.api.url,
              apiKey: secret(model, credential),
              apiVersion: stringOption(model.request.body, "apiVersion"),
              useCompletionUrls: model.request.body.useCompletionUrls === true,
            }
      return Effect.succeed(withOpenAICompatibility(Azure.configure(configured).model(model.api.id), model))
    },
  },
  "@openrouter/ai-sdk-provider": {
    resolve: (model, credential) =>
      Effect.succeed(
        withOpenAICompatibility(
          OpenRouter.configure({
            ...defaults(model),
            baseURL: model.api.url,
            apiKey: secret(model, credential),
          }).model(model.api.id),
          model,
        ),
      ),
  },
  "@ai-sdk/amazon-bedrock": {
    resolve: Effect.fnUntraced(function* (model, credential) {
      const region =
        (typeof model.request.body.region === "string" ? model.request.body.region : undefined) ??
        process.env.AWS_REGION ??
        "us-east-1"
      const accessKeyId = stringOption(model.request.body, "accessKeyId")
      const secretAccessKey = stringOption(model.request.body, "secretAccessKey")
      if ((accessKeyId === undefined) !== (secretAccessKey === undefined))
        return yield* new ProviderConfigurationError({
          providerID: model.providerID,
          modelID: model.id,
          reason: "Amazon Bedrock explicit credentials require both accessKeyId and secretAccessKey",
        })
      const explicitCredentials =
        accessKeyId && secretAccessKey
          ? {
              region,
              accessKeyId,
              secretAccessKey,
              sessionToken: stringOption(model.request.body, "sessionToken"),
            }
          : undefined
      const configuredBearer =
        stringOption(model.request.body, "apiKey") ??
        (model.api.type === "aisdk" ? stringOption(model.api.settings ?? {}, "apiKey") : undefined)
      const value =
        (explicitCredentials ? configuredBearer : secret(model, credential)) ?? process.env.AWS_BEARER_TOKEN_BEDROCK
      const credentials = value
        ? undefined
        : (explicitCredentials ??
          (yield* Effect.tryPromise({
            try: async () => {
              const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers")
              const profile =
                typeof model.request.body.profile === "string" ? model.request.body.profile : process.env.AWS_PROFILE
              const resolved = await fromNodeProviderChain(profile ? { profile } : {})()
              return {
                region,
                accessKeyId: resolved.accessKeyId,
                secretAccessKey: resolved.secretAccessKey,
                sessionToken: resolved.sessionToken,
              }
            },
            catch: () =>
              new ProviderConfigurationError({
                providerID: model.providerID,
                modelID: model.id,
                reason: "Amazon Bedrock credentials could not be resolved",
              }),
          })))
      return AmazonBedrock.configure({
        ...defaults(model),
        apiKey: value,
        credentials,
        region,
        baseURL: model.api.url,
      }).model(AmazonBedrockModel.resolveModelID(model.api.id, region))
    }),
  },
  "@ai-sdk/xai": {
    resolve: (model, credential) =>
      Effect.succeed(
        withOpenAICompatibility(
          XAI.configure({
            ...defaults(model),
            baseURL: model.api.url,
            apiKey: secret(model, credential),
          }).model(model.api.id),
          model,
        ),
      ),
  },
} satisfies Readonly<Record<string, Adapter>>

const adapterFor = (packageName: string): Adapter | undefined =>
  (adapters as Readonly<Record<string, Adapter>>)[packageName]

/**
 * A ChatGPT sign-in can only reach OpenAI through the Codex endpoint, so the model has to be one
 * the canonical OpenAI transport serves: OpenAI's own provider, the first-party `@ai-sdk/openai`
 * package, and no overridden base URL (an OpenAI-compatible gateway is a different server that
 * would never accept these tokens).
 */
const codexRoutable = (model: ModelV2.Info) =>
  model.providerID === ProviderV2.ID.openai &&
  model.api.type === "aisdk" &&
  model.api.package === "@ai-sdk/openai" &&
  model.api.url === undefined

/**
 * The single gate deciding whether a ChatGPT OAuth credential can run a model. The picker and the
 * resolver both call it, so a model can never be offered under a credential that cannot run it.
 */
const codexServes = (model: ModelV2.Info) =>
  codexRoutable(model) &&
  OpenAICodex.eligible(
    model.api.id,
    stringOption(model.request.body, "reasoningMode") ??
      stringOption(recordOption(model.request.body, "reasoning") ?? {}, "mode"),
  )

const chatGPTOAuth = (
  model: ModelV2.Info,
  credential: Credential.OAuth,
): Effect.Effect<Model, ProviderConfigurationError> => {
  if (!codexServes(model))
    return Effect.fail(
      new ProviderConfigurationError({
        providerID: model.providerID,
        modelID: model.id,
        reason: codexRoutable(model)
          ? "your ChatGPT sign-in cannot run this model. Choose a model currently documented for Codex, or connect OpenAI with an API key."
          : `your ChatGPT sign-in only works against OpenAI's own endpoint, which "${model.providerID}" is not. Connect this provider with an API key.`,
      }),
    )
  const accountID =
    credential.metadata && typeof credential.metadata.accountID === "string" ? credential.metadata.accountID : undefined
  return Effect.succeed(
    withDefaults(model, OpenAIResponses.route)
      .with({
        endpoint: { baseURL: OpenAICodex.API_ENDPOINT, path: "" },
        auth: Auth.headers(OpenAICodex.authorizationHeaders(credential.access, accountID)),
      })
      // The Codex endpoint is not the Responses API: it answers
      // `max_output_tokens` with HTTP 400 `{"detail":"Unsupported parameter:
      // max_output_tokens"}`. Every caller that caps output — title generation,
      // compaction — was failing outright against a ChatGPT sign-in. The v1
      // plugin has always cleared it here for the same reason.
      .model({ id: OpenAICodex.codexModelID(model.api.id), compatibility: { maxOutputTokens: false } }),
  )
}

export const supportedPackages = Object.freeze(Object.keys(adapters))

/**
 * Claude Code is the one route in this runtime whose "server" is a local
 * subprocess. It carries no credential and no AI SDK package, so it bypasses
 * every adapter/bridge qualification below and goes straight to the CLI
 * transport.
 */
const claudeCodeModel = (model: ModelV2.Info) => ClaudeCodeBridge.model({ model, defaults: defaults(model) })

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError | ProviderConfigurationError> => {
  if (ClaudeCodeBridge.isClaudeCode(model)) return Effect.succeed(claudeCodeModel(model))
  if (
    model.providerID === ProviderV2.ID.openai &&
    model.api.id === "gpt-5.3-codex-spark" &&
    credential?.type !== "oauth"
  )
    return Effect.fail(
      new ProviderConfigurationError({
        providerID: model.providerID,
        modelID: model.id,
        reason: "OpenAI offers GPT-5.3 Codex Spark only through ChatGPT Pro sign-in",
      }),
    )
  if (model.api.type !== "aisdk" || !adapterFor(model.api.package) || !nativeQualified(model))
    return Effect.fail(
      new UnsupportedApiError({
        providerID: model.providerID,
        modelID: model.id,
        api: apiName(model),
      }),
    )
  const adapter = adapterFor(model.api.package)
  if (!adapter)
    return Effect.fail(
      new UnsupportedApiError({
        providerID: model.providerID,
        modelID: model.id,
        api: apiName(model),
      }),
    )
  return requireDirectCredential(model, credential).pipe(
    Effect.flatMap(() => {
      return adapter.resolve(credentialConfiguration(model, credential), credential)
    }),
  )
}

export const fromCatalogModelWithAISDK = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError | ProviderConfigurationError, AISDK.Service> => {
  if (ClaudeCodeBridge.isClaudeCode(model)) return Effect.succeed(claudeCodeModel(model))
  if (credential?.type === "oauth" && model.providerID === ProviderV2.ID.openai) return chatGPTOAuth(model, credential)
  if (
    model.api.type === "aisdk" &&
    adapterFor(model.api.package) &&
    nativeQualified(model) &&
    credential?.type !== "oauth"
  )
    return fromCatalogModel(model, credential)
  if (!bridgeQualified(model))
    return Effect.fail(
      new UnsupportedApiError({
        providerID: model.providerID,
        modelID: model.id,
        api: apiName(model),
      }),
    )
  const configured = bridgeCredentialConfiguration(model, credential)
  return bridgeConfiguration(configured, credential).pipe(
    Effect.flatMap(() => {
      return AISDK.Service.pipe(
        Effect.flatMap((aisdk) => aisdk.language(configured)),
        Effect.mapError(
          () =>
            new ProviderConfigurationError({
              providerID: model.providerID,
              modelID: model.id,
              reason: "AI SDK provider initialization failed",
            }),
        ),
        Effect.map((language) =>
          AISDKBridge.model({
            language,
            model: configured,
            defaults: defaults(configured),
            compatibility: openAICompatibility(configured),
          }),
        ),
      )
    }),
  )
}

const resolveWith = <R>(
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential: Credential.Value | undefined,
  request: ProviderV2.Request | undefined,
  resolver: (
    selected: ModelV2.Info,
    value?: Credential.Value,
  ) => Effect.Effect<Model, UnsupportedApiError | ProviderConfigurationError, R>,
) => {
  const selected = withVariant(model, session.model?.variant, request)
  return resolver(selected.model, credential).pipe(
    Effect.map(
      (resolved): Resolved => ({
        model: resolved,
        ref: ModelV2.Ref.make({
          id: model.id,
          providerID: model.providerID,
          ...(selected.variant === undefined ? {} : { variant: selected.variant }),
        }),
        // From the variant-resolved info, so a variant that carries its own
        // price list is billed at its own rates.
        cost: selected.model.cost,
      }),
    ),
  )
}

export const resolveWithRef = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  request?: ProviderV2.Request,
) => resolveWith(session, model, credential, request, fromCatalogModel)

export const resolveWithAISDKRef = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  request?: ProviderV2.Request,
) => resolveWith(session, model, credential, request, fromCatalogModelWithAISDK)

export const resolve = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
  request?: ProviderV2.Request,
) => resolveWithRef(session, model, credential, request).pipe(Effect.map((resolved) => resolved.model))

export const supported = (model: ModelV2.Info) =>
  ClaudeCodeBridge.isClaudeCode(model) ||
  (model.api.type === "aisdk" &&
    ((adapterFor(model.api.package) !== undefined && nativeQualified(model)) || bridgeQualified(model)))

export const selectable = (model: ModelV2.Info) => model.capabilities.tools && supported(model)

export const selectableWithCredential = (model: ModelV2.Info, credential: Credential.Value | undefined) => {
  if (!selectable(model)) return false
  if (model.providerID !== ProviderV2.ID.openai) return true
  if (model.api.id === "gpt-5.3-codex-spark") return credential?.type === "oauth"
  if (credential?.type !== "oauth") return true
  return codexServes(model)
}

type CredentialResolution =
  | { readonly resolved: true; readonly value: Credential.Value | undefined }
  | { readonly resolved: false }

const providerCredential = (
  providerID: ProviderV2.ID,
  integrationID: Integration.ID | undefined,
  integrations: Integration.Interface,
) =>
  integrations.connection
    .active(integrationID ?? Integration.ID.make(providerID))
    .pipe(
      Effect.flatMap((connection) =>
        connection ? integrations.connection.resolve(connection) : Effect.succeed(undefined),
      ),
    )

const availableModels = Effect.fnUntraced(function* (catalog: Catalog.Interface, integrations: Integration.Interface) {
  const models = yield* catalog.model.available()
  const credentials = new Map<ProviderV2.ID, CredentialResolution>(
    yield* Effect.forEach(
      Array.from(new Set(models.map((model) => model.providerID))),
      Effect.fnUntraced(function* (providerID) {
        const provider = yield* catalog.provider.get(providerID)
        const resolution = yield* providerCredential(providerID, provider?.integrationID, integrations).pipe(
          Effect.match({
            onFailure: (): CredentialResolution => ({ resolved: false }),
            onSuccess: (value): CredentialResolution => ({ resolved: true, value }),
          }),
        )
        return [providerID, resolution] as const
      }),
    ),
  )
  return models.flatMap((model) => {
    const credential = credentials.get(model.providerID)
    if (!credential?.resolved || !selectableWithCredential(model, credential.value)) return []
    return [{ model, credential: credential.value }]
  })
})

/** Lists only models whose active provider credential can be resolved and safely routed. */
export const available = Effect.fn("SessionRunnerModel.available")(function* () {
  return (yield* availableModels(yield* Catalog.Service, yield* Integration.Service)).map((item) => item.model)
})

/**
 * Explains why a pinned model missed `catalog.model.available()`. The composer builds its list
 * from a different catalog, so a model it offers can be absent here for structurally different
 * reasons — name each one instead of emitting one indistinguishable "Model unavailable".
 */
const unavailableReason = Effect.fnUntraced(function* (
  catalog: Catalog.Interface,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
) {
  const provider = yield* catalog.provider.get(providerID)
  if (!provider) return `provider "${providerID}" is not in this runtime's catalog, so the model cannot be run here`
  if (!(yield* catalog.provider.available()).some((item) => item.id === providerID))
    return `provider "${providerID}" has no usable credential`
  const model = yield* catalog.model.get(providerID, modelID)
  if (!model) return `provider "${providerID}" does not publish model "${modelID}"`
  return `model "${modelID}" is disabled`
})

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const aisdk = yield* AISDK.Service
    // Location plugins populate and filter the catalog asynchronously during
    // layer startup, so the very first resolve after boot can race an empty
    // catalog. A pinned model that is genuinely unavailable still fails, just
    // after the bounded wait — a short delay on a real failure beats failing
    // every session's first turn.
    //
    // The bound is wall clock rather than a count of attempts. Each attempt re-reads the whole
    // catalog and resolves a credential per provider, which on a populated catalog costs about as
    // much as the sleep between attempts, so 200 attempts at 50ms was twenty seconds rather than
    // the ten it reads as — long enough that a model whose provider is simply gone pushed callers
    // past their own deadlines before it could say so.
    const selectedModel = (session: SessionSchema.Info): Effect.Effect<ModelV2.Info | undefined> =>
      Effect.gen(function* () {
        while (true) {
          const selected = (yield* catalog.model.available()).find(
            (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
          )
          if (selected || !session.model) return selected
          // Once the catalog publishes the pinned model at all, its absence from
          // `available()` is a real answer (disabled, or no usable credential) —
          // keep waiting only while the catalog has yet to publish it.
          if (yield* catalog.model.get(session.model.providerID, session.model.id)) return selected
          yield* Effect.sleep("50 millis")
        }
      }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(undefined) }))
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, request) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        if (session.model) {
          const selected = yield* selectedModel(session)
          if (!selected)
            return yield* new ModelUnavailableError({
              providerID: session.model.providerID,
              modelID: session.model.id,
              reason: yield* unavailableReason(catalog, session.model.providerID, session.model.id),
            })
          const provider = yield* catalog.provider.get(selected.providerID)
          return yield* resolveWithAISDKRef(
            session,
            selected,
            yield* providerCredential(selected.providerID, provider?.integrationID, integrations),
            request,
          ).pipe(Effect.provideService(AISDK.Service, aisdk))
        }

        // Same boot race as the pinned path: an unpinned session resolving
        // before plugins have populated the catalog would fail spuriously with
        // ModelNotSelectedError. Wait while the catalog is still empty.
        let candidates = yield* availableModels(catalog, integrations)
        let defaultModel = yield* catalog.model.default()
        for (let retries = 200; retries > 0 && candidates.length === 0 && defaultModel === undefined; retries--) {
          yield* Effect.sleep("50 millis")
          candidates = yield* availableModels(catalog, integrations)
          defaultModel = yield* catalog.model.default()
        }
        const selected =
          candidates.find(
            (candidate) =>
              defaultModel !== undefined &&
              candidate.model.providerID === defaultModel.providerID &&
              candidate.model.id === defaultModel.id,
          ) ?? candidates[0]
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        return yield* resolveWithAISDKRef(session, selected.model, selected.credential, request).pipe(
          Effect.provideService(AISDK.Service, aisdk),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [AISDK.node, Catalog.node, Integration.node],
})
