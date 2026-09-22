import type { ProviderOptions, ReasoningEffort, TextVerbosity } from "../schema"
import { mergeProviderOptions } from "../schema"
import type {
  OpenAIReasoningContext,
  OpenAIReasoningMode,
  OpenAIResponseIncludable,
  OpenAIServiceTier,
} from "../protocols/utils/openai-options"

export type {
  OpenAIReasoningContext,
  OpenAIReasoningMode,
  OpenAIResponseIncludable,
  OpenAIServiceTier,
} from "../protocols/utils/openai-options"

export interface OpenAIOptionsInput {
  readonly [key: string]: unknown
  readonly store?: boolean
  readonly promptCacheKey?: string
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningSummary?: "auto"
  readonly reasoningMode?: OpenAIReasoningMode
  readonly reasoningContext?: OpenAIReasoningContext
  // OpenAI Responses `include` wire field. Mirrors the official SDK's
  // `ResponseIncludable[]` union exactly so AI SDK callers and direct
  // native-SDK callers share one shape and no translation is required.
  readonly include?: ReadonlyArray<OpenAIResponseIncludable>
  readonly textVerbosity?: TextVerbosity
  readonly serviceTier?: OpenAIServiceTier
}

export type OpenAIProviderOptionsInput = ProviderOptions & {
  readonly openai?: OpenAIOptionsInput
}

const definedEntries = (input: Record<string, unknown>) =>
  Object.entries(input).filter((entry) => entry[1] !== undefined)

const openAIProviderOptions = (options: OpenAIOptionsInput | undefined): ProviderOptions | undefined => {
  const openai = Object.fromEntries(
    definedEntries({
      store: options?.store,
      promptCacheKey: options?.promptCacheKey,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      reasoningMode: options?.reasoningMode,
      reasoningContext: options?.reasoningContext,
      include: options?.include,
      textVerbosity: options?.textVerbosity,
      serviceTier: options?.serviceTier,
    }),
  )
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

export const gpt5DefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined => {
  const id = modelID.toLowerCase()
  if (!id.includes("gpt-5") || id.includes("-chat") || /gpt-5(?:[.-]\d+)?[.-]pro(?:[.-]|$)/.test(id)) return undefined
  return openAIProviderOptions({
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    // GPT-5 reasoning models are configured stateless (`store: false`) by
    // `openAIDefaultOptions` below, so the only way a follow-up turn can
    // carry reasoning state is via the encrypted reasoning include. Without
    // this, callers using the default model facade get reasoning summaries
    // they cannot replay statelessly.
    include: ["reasoning.encrypted_content"],
    textVerbosity:
      options.textVerbosity === true && id.includes("gpt-5.") && !id.includes("codex") && !id.includes("-chat")
        ? "low"
        : undefined,
  })
}

export const openAIDefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined =>
  mergeProviderOptions(
    openAIProviderOptions({ store: false }),
    modelID.toLowerCase().startsWith("gpt-6")
      ? openAIProviderOptions({
          reasoningEffort: "medium",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        })
      : gpt5DefaultOptions(modelID, options),
  )

export const withOpenAIOptions = <Options extends { readonly providerOptions?: OpenAIProviderOptionsInput }>(
  modelID: string,
  options: Options,
  defaults: { readonly textVerbosity?: boolean } = {},
): Omit<Options, "providerOptions"> & { readonly providerOptions?: ProviderOptions } => {
  return {
    ...options,
    providerOptions: mergeProviderOptions(openAIDefaultOptions(modelID, defaults), options.providerOptions),
  }
}

export * as OpenAIProviderOptions from "./openai-options"
