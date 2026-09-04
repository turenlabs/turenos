import { Schema } from "effect"
import { JsonSchema, ModelID, ProviderID } from "./ids"
import type { AnyRoute } from "../route/client"
import { isRecord } from "../utils/record"

export const mergeJsonRecords = (
  ...items: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined => {
  const defined = items.filter((item): item is Record<string, unknown> => item !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1 && Object.values(defined[0]).every((value) => value !== undefined)) return defined[0]
  const result: Record<string, unknown> = {}
  for (const item of defined) {
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue
      result[key] = isRecord(result[key]) && isRecord(value) ? mergeJsonRecords(result[key], value) : value
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

const mergeStringRecords = (
  ...items: ReadonlyArray<Record<string, string> | undefined>
): Record<string, string> | undefined => {
  const defined = items.filter((item): item is Record<string, string> => item !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  const result = Object.fromEntries(
    defined.flatMap((item) =>
      Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

export const ProviderOptions = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
export type ProviderOptions = Schema.Schema.Type<typeof ProviderOptions>

export const mergeProviderOptions = (
  ...items: ReadonlyArray<ProviderOptions | undefined>
): ProviderOptions | undefined => {
  const result: Record<string, Record<string, unknown>> = {}
  for (const item of items) {
    if (!item) continue
    for (const [provider, options] of Object.entries(item)) {
      const merged = mergeJsonRecords(result[provider], options)
      if (merged) result[provider] = merged
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

export class HttpOptions extends Schema.Class<HttpOptions>("LLM.HttpOptions")({
  body: Schema.optional(JsonSchema),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  redirect: Schema.optional(Schema.Literals(["error", "follow", "manual"])),
}) {}

export namespace HttpOptions {
  export type Input = HttpOptions | ConstructorParameters<typeof HttpOptions>[0]

  /** Normalize HTTP option input into the canonical `HttpOptions` class. */
  export const make = (input: Input) => (input instanceof HttpOptions ? input : new HttpOptions(input))
}

export const mergeHttpOptions = (...items: ReadonlyArray<HttpOptions | undefined>): HttpOptions | undefined => {
  const body = mergeJsonRecords(...items.map((item) => item?.body))
  const headers = mergeStringRecords(...items.map((item) => item?.headers))
  const query = mergeStringRecords(...items.map((item) => item?.query))
  const redirect = items.findLast((item) => item?.redirect !== undefined)?.redirect
  if (!body && !headers && !query && !redirect) return undefined
  return new HttpOptions({ body, headers, query, redirect })
}

export class GenerationOptions extends Schema.Class<GenerationOptions>("LLM.GenerationOptions")({
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  frequencyPenalty: Schema.optional(Schema.Number),
  presencePenalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
}) {}

export namespace GenerationOptions {
  export type Input = GenerationOptions | ConstructorParameters<typeof GenerationOptions>[0]

  /** Normalize generation option input into the canonical `GenerationOptions` class. */
  export const make = (input: Input = {}) => (input instanceof GenerationOptions ? input : new GenerationOptions(input))
}

export type GenerationOptionsFields = {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly seed?: number
  readonly stop?: ReadonlyArray<string>
}

export type GenerationOptionsInput = GenerationOptions | GenerationOptionsFields

const latestGeneration = <Key extends keyof GenerationOptionsFields>(
  items: ReadonlyArray<GenerationOptionsInput | undefined>,
  key: Key,
) => items.findLast((item) => item?.[key] !== undefined)?.[key]

export const mergeGenerationOptions = (...items: ReadonlyArray<GenerationOptionsInput | undefined>) => {
  const result = new GenerationOptions({
    maxTokens: latestGeneration(items, "maxTokens"),
    temperature: latestGeneration(items, "temperature"),
    topP: latestGeneration(items, "topP"),
    topK: latestGeneration(items, "topK"),
    frequencyPenalty: latestGeneration(items, "frequencyPenalty"),
    presencePenalty: latestGeneration(items, "presencePenalty"),
    seed: latestGeneration(items, "seed"),
    stop: latestGeneration(items, "stop"),
  })
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

export class ModelLimits extends Schema.Class<ModelLimits>("LLM.ModelLimits")({
  context: Schema.optional(Schema.Number),
  /**
   * Largest prompt the model accepts, when it is smaller than `context` minus
   * `output`. Most catalog entries omit it, but where it is published it is not
   * derivable: of the models.dev entries that declare one, roughly two thirds
   * have `context - output != input`. Dropping it therefore over-estimates the
   * usable prompt budget rather than merely duplicating it.
   */
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
}) {}

export namespace ModelLimits {
  export type Input = ModelLimits | ConstructorParameters<typeof ModelLimits>[0]

  /** Normalize model limit input into the canonical `ModelLimits` class. */
  export const make = (input: Input | undefined) =>
    input instanceof ModelLimits ? input : new ModelLimits(input ?? {})
}

export class ModelDefaults extends Schema.Class<ModelDefaults>("LLM.ModelDefaults")({
  limits: Schema.optional(ModelLimits),
  generation: Schema.optional(GenerationOptions),
  providerOptions: Schema.optional(ProviderOptions),
  http: Schema.optional(HttpOptions),
}) {}

export namespace ModelDefaults {
  export type Input =
    | ModelDefaults
    | {
        readonly limits?: ModelLimits.Input
        readonly generation?: GenerationOptions.Input
        readonly providerOptions?: ProviderOptions
        readonly http?: HttpOptions.Input
      }

  /** Normalize selected-model request defaults without applying precedence. */
  export const make = (input: Input) => {
    if (input instanceof ModelDefaults) return input
    return new ModelDefaults({
      limits: input.limits === undefined ? undefined : ModelLimits.make(input.limits),
      generation: input.generation === undefined ? undefined : GenerationOptions.make(input.generation),
      providerOptions: input.providerOptions,
      http: input.http === undefined ? undefined : HttpOptions.make(input.http),
    })
  }
}

export const ModelToolSchemaCompatibility = Schema.Literals(["gemini", "moonshot"])
export type ModelToolSchemaCompatibility = Schema.Schema.Type<typeof ModelToolSchemaCompatibility>

export class ModelCompatibility extends Schema.Class<ModelCompatibility>("LLM.ModelCompatibility")({
  toolSchema: Schema.optional(ModelToolSchemaCompatibility),
  /**
   * Whether the upstream accepts an output-token cap. `false` drops it from the
   * request body: the ChatGPT Codex endpoint rejects `max_output_tokens`
   * outright (HTTP 400 `{"detail":"Unsupported parameter: max_output_tokens"}`),
   * so a caller that sets one — title generation, compaction — fails the whole
   * request rather than being capped.
   */
  maxOutputTokens: Schema.optional(Schema.Boolean),
  /**
   * Whether every assistant message must carry `reasoning_content` back. DeepSeek and
   * GLM thinking modes fail the request with "The `reasoning_content` in the thinking
   * mode must be passed back to the API" as soon as one assistant turn -- typically a
   * tool-call-only turn the model emitted without reasoning -- omits the field.
   */
  reasoningPassback: Schema.optional(Schema.Boolean),
  /**
   * Whether the upstream accepts image parts. `false` keeps them off the wire: a text-only model
   * fails the whole request with "Model only supports text input; received unsupported content
   * type 'image_url'". Because the attachment stays in the transcript, every later turn re-sends it
   * and fails identically, so the Session cannot recover without editing its history.
   */
  mediaInput: Schema.optional(Schema.Boolean),
}) {}

export namespace ModelCompatibility {
  export type Input = ModelCompatibility | ConstructorParameters<typeof ModelCompatibility>[0]

  /** Normalize model/upstream compatibility metadata without projecting requests. */
  export const make = (input: Input) => (input instanceof ModelCompatibility ? input : new ModelCompatibility(input))
}

export class Model {
  readonly id: ModelID
  readonly provider: ProviderID
  readonly route: AnyRoute
  readonly defaults?: ModelDefaults
  readonly compatibility?: ModelCompatibility

  constructor(input: Model.ConstructorInput) {
    this.id = input.id
    this.provider = input.provider
    this.route = input.route
    this.defaults = input.defaults
    this.compatibility = input.compatibility
  }

  static make(input: Model.Input) {
    return new Model({
      id: ModelID.make(input.id),
      provider: ProviderID.make(input.provider),
      route: input.route,
      defaults: input.defaults === undefined ? undefined : ModelDefaults.make(input.defaults),
      compatibility: input.compatibility === undefined ? undefined : ModelCompatibility.make(input.compatibility),
    })
  }

  static input(model: Model): Model.ConstructorInput {
    return {
      id: model.id,
      provider: model.provider,
      route: model.route,
      defaults: model.defaults,
      compatibility: model.compatibility,
    }
  }

  static update(model: Model, patch: Partial<Model.Input>) {
    if (Object.keys(patch).length === 0) return model
    return Model.make({
      ...Model.input(model),
      ...patch,
    })
  }
}

export namespace Model {
  export type ConstructorInput = {
    readonly id: ModelID
    readonly provider: ProviderID
    readonly route: AnyRoute
    readonly defaults?: ModelDefaults
    readonly compatibility?: ModelCompatibility
  }

  export type Input = Omit<ConstructorInput, "id" | "provider" | "defaults" | "compatibility"> & {
    readonly id: string | ModelID
    readonly provider: string | ProviderID
    readonly defaults?: ModelDefaults.Input
    readonly compatibility?: ModelCompatibility.Input
  }
}

export type ModelInput = Model.Input

export const ModelSchema = Schema.declare((value): value is Model => value instanceof Model, { expected: "LLM.Model" })

export class CacheHint extends Schema.Class<CacheHint>("LLM.CacheHint")({
  type: Schema.Literals(["ephemeral", "persistent"]),
  ttlSeconds: Schema.optional(Schema.Number),
}) {}

// Auto-placement policy for prompt caching. The protocol-neutral lowering step
// reads this and injects `CacheHint`s at the configured boundaries; the
// per-protocol body builders then translate those hints into wire markers as
// usual. `"auto"` is the recommended default for agent loops — it places one
// breakpoint at the last tool definition, one at the last system part, one
// at the latest user message, and one at the latest durable message. This
// covers the static prefix and advances through tool results during long turns.
//
// Pass `"none"` to opt out entirely (the legacy behavior). Pass the granular
// object form to override individual choices.
export const CachePolicyObject = Schema.Struct({
  tools: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  messages: Schema.optional(
    Schema.Union([
      Schema.Literal("latest-user-message"),
      Schema.Literal("latest-assistant"),
      Schema.Struct({ tail: Schema.Number }),
    ]),
  ),
  ttlSeconds: Schema.optional(Schema.Number),
})
export type CachePolicyObject = Schema.Schema.Type<typeof CachePolicyObject>

export const CachePolicy = Schema.Union([Schema.Literal("auto"), Schema.Literal("none"), CachePolicyObject])
export type CachePolicy = Schema.Schema.Type<typeof CachePolicy>
