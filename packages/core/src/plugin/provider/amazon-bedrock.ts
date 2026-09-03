import { Effect } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { define } from "../define"
import { ProviderV2 } from "../../provider"
import { resolveModelID } from "./amazon-bedrock-model"

type MantleSDK = {
  languageModel: (modelID: string) => LanguageModelV3
  chat: (modelID: string) => LanguageModelV3
  responses: (modelID: string) => LanguageModelV3
}

function selectMantleModel(sdk: MantleSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat(modelID)
  return sdk.responses(modelID)
}

export const AmazonBedrockPlugin = define({
  id: "amazon-bedrock",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/amazon-bedrock") continue
          evt.provider.update(item.provider.id, (provider) => {
            if (provider.api.type !== "aisdk") return
            if (typeof provider.request.body.endpoint !== "string") return
            // The AI SDK expects a base URL, but users configure Bedrock private/VPC
            // endpoints as `endpoint`; move it into the catalog endpoint URL once.
            provider.api.url = provider.request.body.endpoint
            delete provider.request.body.endpoint
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (!["@ai-sdk/amazon-bedrock", "@ai-sdk/amazon-bedrock/mantle"].includes(evt.package)) return
        const options = { ...evt.options }
        const profile = typeof options.profile === "string" ? options.profile : process.env.AWS_PROFILE
        const region = typeof options.region === "string" ? options.region : (process.env.AWS_REGION ?? "us-east-1")
        const bearerToken =
          process.env.AWS_BEARER_TOKEN_BEDROCK ??
          (typeof options.apiKey === "string"
            ? options.apiKey
            : typeof options.bearerToken === "string"
              ? options.bearerToken
              : undefined)
        const containerCreds = Boolean(
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
        )

        options.region = region
        if (bearerToken) options.apiKey = bearerToken
        if (typeof options.endpoint === "string") options.baseURL = options.endpoint
        if (!bearerToken && options.credentialProvider === undefined) {
          // Do not gate SDK creation on explicit AWS env vars. The default chain
          // also handles ~/.aws/credentials, SSO, process creds, and instance roles.
          const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))
          options.credentialProvider = fromNodeProviderChain(profile ? { profile } : {})
        }

        if (evt.package === "@ai-sdk/amazon-bedrock/mantle") {
          const mod = yield* Effect.promise(() => import("@ai-sdk/amazon-bedrock/mantle"))
          evt.sdk = mod.createBedrockMantle(options)
          return
        }

        const mod = yield* Effect.promise(() => import("@ai-sdk/amazon-bedrock"))
        evt.sdk = mod.createAmazonBedrock(options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.amazonBedrock) return
        if (evt.model.api.type === "aisdk" && evt.model.api.package === "@ai-sdk/amazon-bedrock/mantle") {
          evt.language = selectMantleModel(evt.sdk, evt.model.api.id)
          return
        }
        const region = typeof evt.options.region === "string" ? evt.options.region : process.env.AWS_REGION
        evt.language = evt.sdk.languageModel(resolveModelID(evt.model.api.id, region))
      }),
    )
  }),
})
