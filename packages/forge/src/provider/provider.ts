import { LayerNode } from "@turenlabs/core/effect/layer-node"
import os from "os"
import { createHash } from "node:crypto"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Npm } from "@turenlabs/core/npm"
import { Hash } from "@turenlabs/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelsDev } from "@turenlabs/core/models-dev"
import { Integration } from "@turenlabs/core/integration"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { iife } from "@/util/iife"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Storage } from "@turenlabs/core/storage"
import { isRecord } from "@/util/record"
import { NonNegativeInt, optional } from "@turenlabs/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { ModelStatus } from "./model-status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"
import { ClaudeCodeProvider } from "./claude-code"
import { MuseCodeProvider } from "./muse-code"
import { ModelStorage } from "@/model-storage"
import {
  assertConnectionPolicyOptions,
  connectionPolicyKey,
  ConnectionPolicyError,
  createConnectionPolicyFetch,
  type ConnectionPolicy,
} from "./connection-policy"

const OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000
const OLLAMA_PROVIDER_ID = "ollama"
const OLLAMA_DEFAULT_ENDPOINT = "http://127.0.0.1:11434"
const OLLAMA_DEFAULT_CONTEXT = 32_768
const OLLAMA_DEFAULT_OUTPUT = 8_192
const OLLAMA_DISCOVERY_TIMEOUT = 750
const OLLAMA_DISCOVERY_TTL = 10_000

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          // Aborting fetch can reject cancellation too; the read reports the timeout below.
          void reader.cancel(err).catch(() => undefined)
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

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("@turenlabs/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
}

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model> | undefined>
type CustomLoader = (provider: Info) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<ConfigV1.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
}

function selectAzureLanguageModel(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

function selectBedrockMantleLanguageModel(sdk: BundledSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
  return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    ollama: Effect.fnUntraced(function* () {
      const config = yield* dep.config()
      const provider = config.provider?.[OLLAMA_PROVIDER_ID]
      const endpoint = normalizeOllamaEndpoint(
        provider?.options?.baseURL ?? provider?.api ?? (yield* dep.get("OLLAMA_HOST")) ?? OLLAMA_DEFAULT_ENDPOINT,
      )
      if (!endpoint) return { autoload: false }

      return {
        autoload: true,
        options: {
          apiKey: "ollama",
          baseURL: `${endpoint}/v1`,
        },
        discoverModels: () => discoverOllamaModels(endpoint),
      }
    }),
    "claude-code": Effect.fnUntraced(function* (input: Info) {
      const result = yield* Effect.promise(() => ClaudeCodeProvider.probe(input.options.executable))
      return {
        autoload: result.status === "authenticated",
        options: result.status === "authenticated" ? { executable: result.executable } : {},
      }
    }),
    "muse-code": Effect.fnUntraced(function* (input: Info) {
      const result = yield* Effect.promise(() => MuseCodeProvider.probe(input.options.executable))
      return {
        autoload: result.status === "installed",
        options: result.status === "installed" ? { executable: result.executable } : {},
      }
    }),
    anthropic: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    openai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }),
    meta: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
      }),
    xai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }),
    "github-copilot": () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          if (model && "endpoint" in model.api) {
            if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
            if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          }
          const match = /^gpt-(\d+)/.exec(modelID)
          if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }),
    azure: Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(provider.id)
      const resource = iife(() => {
        return [
          provider.options?.resourceName,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          env["AZURE_RESOURCE_NAME"],
        ].find((name) => typeof name === "string" && name.trim() !== "")
      })

      if (!resource && !provider.options?.baseURL) {
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          },
        }
      }

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          resourceName: resource,
        },
        vars(_options): Record<string, string> {
          if (resource) {
            return {
              AZURE_RESOURCE_NAME: resource,
            }
          }
          return {}
        },
      }
    }),
    "azure-cognitive-services": Effect.fnUntraced(function* (provider: Info) {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName
            ? `https://${resourceName}.cognitiveservices.azure.com/openai${provider.options?.useDeploymentBasedUrls ? "" : "/v1"}`
            : undefined,
        },
      }
    }),
    "amazon-bedrock": Effect.fnUntraced(function* () {
      const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
      const auth = yield* dep.auth("amazon-bedrock")
      const env = yield* dep.env()

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = env["AWS_REGION"]
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = env["AWS_PROFILE"]
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]
      const configApiKey = providerConfig?.options?.apiKey

      const awsBearerToken = env["AWS_BEARER_TOKEN_BEDROCK"] ?? (auth?.type === "api" ? auth.key : undefined)

      const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !awsWebIdentityTokenFile &&
        !containerCreds
      )
        return { autoload: false }

      const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))

      const providerOptions: Record<string, any> = {
        region: defaultRegion,
        ...(configApiKey || awsBearerToken ? { apiKey: configApiKey || awsBearerToken } : {}),
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken && !configApiKey) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options: Record<string, any>) {
          return { AWS_REGION: options.region ?? defaultRegion }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from forge.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    }),
    llmgateway: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/turenlabs/forge/",
            "X-Title": "Forge",
            "X-Source": "Turen",
          },
        },
      }),
    openrouter: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/turenlabs/forge/",
            "X-Title": "Forge",
          },
        },
      }),
    nvidia: (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/turenlabs/forge/",
            "X-Title": "Forge",
            "X-BILLING-INVOKE-ORIGIN": "Forge",
          },
        },
      }),
    vercel: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://github.com/turenlabs/forge/",
            "x-title": "Turen",
          },
        },
      }),
    "google-vertex": Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
      // Google Cloud project env names as fallbacks for existing ADC setups.
      const project =
        provider.options?.project ??
        env["GOOGLE_VERTEX_PROJECT"] ??
        env["GOOGLE_CLOUD_PROJECT"] ??
        env["GCP_PROJECT"] ??
        env["GCLOUD_PROJECT"]

      const location = String(
        provider.options?.location ??
          env["GOOGLE_VERTEX_LOCATION"] ??
          env["GOOGLE_CLOUD_LOCATION"] ??
          env["VERTEX_LOCATION"] ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const { GoogleAuth } = await import("google-auth-library")
            const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
            const client = await auth.getClient()
            const token = await client.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "google-vertex-anthropic": Effect.fnUntraced(function* () {
      const env = yield* dep.env()
      const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
      const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      const baseURL = googleVertexAnthropicBaseURL(project, location)
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(baseURL && { baseURL }),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "sap-ai-core": Effect.fnUntraced(function* () {
      const auth = yield* dep.auth("sap-ai-core")
      const envServiceKey = process.env.AICORE_SERVICE_KEY
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: Boolean(envServiceKey),
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          if (!envServiceKey && auth?.type === "api") {
            throw new Error(
              "Stored SAP AI Core credentials cannot be applied without exposing them process-wide. Set AICORE_SERVICE_KEY in the TurenOS server environment.",
            )
          }
          return sdk(modelID)
        },
      }
    }),
    zenmux: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/turenlabs/forge/",
            "X-Title": "Forge",
          },
        },
      }),
    gitlab: Effect.fnUntraced(function* (input: Info) {
      const {
        VERSION: GITLAB_PROVIDER_VERSION,
        isWorkflowModel,
        discoverWorkflowModels,
      } = yield* Effect.promise(() => import("gitlab-ai-provider"))

      const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
      const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

      const providerConfig = (yield* dep.config()).provider?.["gitlab"]
      const directory = yield* InstanceState.directory

      const aiGatewayHeaders = {
        "User-Agent": `forge/${InstallationVersion} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...providerConfig?.options?.aiGatewayHeaders,
      }

      const featureFlags = {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
        ...providerConfig?.options?.featureFlags,
      }

      return {
        autoload: !!token,
        options: {
          instanceUrl,
          apiKey: token,
          aiGatewayHeaders,
          featureFlags,
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (modelID.startsWith("duo-workflow-")) {
            const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
            // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
            const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
            const workflowDefinition =
              typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
            const model = sdk.workflowChat(sdkModelID, {
              featureFlags,
              workflowDefinition,
            })
            if (workflowRef) {
              model.selectedModelRef = workflowRef
            }
            return model
          }
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags,
          })
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!apiKey) {
            return {}
          }

          try {
            const token = apiKey
            const getHeaders = (): Record<string, string> =>
              auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

            const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

            if (!result.models.length) {
              return {}
            }

            const models: Record<string, Model> = {}
            for (const m of result.models) {
              if (!input.models[m.id]) {
                models[m.id] = {
                  id: ModelV2.ID.make(m.id),
                  providerID: ProviderV2.ID.make("gitlab"),
                  name: `Agent Platform (${m.name})`,
                  family: "",
                  api: {
                    id: m.id,
                    url: instanceUrl,
                    npm: "gitlab-ai-provider",
                  },
                  status: "active",
                  headers: {},
                  options: { workflowRef: m.ref },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: m.context, output: m.output },
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: true,
                    toolcall: true,
                    input: {
                      text: true,
                      audio: false,
                      image: true,
                      video: false,
                      pdf: true,
                    },
                    output: {
                      text: true,
                      audio: false,
                      image: false,
                      video: false,
                      pdf: false,
                    },
                    interleaved: false,
                  },
                  release_date: "",
                  variants: {},
                }
              }
            }

            return models
          } catch (e) {
            return {}
          }
        },
      }
    }),
    "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
      // skip the account ID check because the URL is already fully specified.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      if (!accountId)
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
            )
          },
        }

      const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          headers: {
            "User-Agent": `forge/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    }),
    "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config), skip the ID checks.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      // The Cloudflare auth prompt stores this value as gatewayId metadata.
      const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

      if (!accountId || !gateway) {
        const missing = [
          !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
          !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
        ].filter((x): x is string => Boolean(x))
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
            )
          },
        }
      }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken =
        env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"] || (auth?.type === "api" ? auth.key : undefined)

      if (!apiToken) {
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `forge auth cloudflare-ai-gateway`.",
        )
      }

      // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
      const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
      const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
        headers: {
          "User-Agent": `forge/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
        },
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      const unified = createUnified({ apiKey: apiToken })

      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
          return aigateway(unified(modelID))
        },
        options: {},
      }
    }),
    cerebras: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "Forge",
          },
        },
      }),
    kilo: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/turenlabs/forge/",
            "X-Title": "Forge",
          },
        },
      }),
    "snowflake-cortex": Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)

      const account =
        env["SNOWFLAKE_ACCOUNT"] ??
        (auth?.type === "api" ? auth.metadata?.account : undefined) ??
        (auth?.type === "oauth" ? auth.accountId : undefined) ??
        input.options?.account

      const envToken = env["SNOWFLAKE_CORTEX_TOKEN"] ?? env["SNOWFLAKE_CORTEX_PAT"]
      const apiKeyToken = auth?.type === "api" ? auth.key : undefined
      const oauthToken = auth?.type === "oauth" ? auth.access : undefined
      const configToken = input.options?.token ?? input.options?.apiKey

      const token = envToken ?? apiKeyToken ?? oauthToken ?? configToken

      if (!account || !token) {
        const missing = [!account && "SNOWFLAKE_ACCOUNT", !token && "SNOWFLAKE_CORTEX_TOKEN"].filter(Boolean).join(", ")
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `Snowflake Cortex: missing credentials (${missing}). Provide a bearer token (OAuth, JWT, or PAT) via env var, forge auth, or provider options.`,
            )
          },
        }
      }

      const baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`

      const options: Record<string, any> = { baseURL, apiKey: token }

      // Only skip provider-level fetch when the token is from OAuth with no override.
      // For OAuth tokens, the plugin auth loader's combined fetch handles
      // OAuth refresh + snowflake transformations in one place.
      // For env/config/API-key tokens, the provider fetch applies snowflake
      // transformations directly.
      const useOAuthHandler =
        oauthToken !== undefined && envToken === undefined && apiKeyToken === undefined && configToken === undefined
      if (!useOAuthHandler) {
        options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body)
              if ("max_tokens" in body) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {}
          }

          const response = await fetch(url, init)

          if (!response.ok && response.status === 400) {
            try {
              const errorData = await response.clone().json()
              const errorMessage = String(errorData.message || errorData.error || "")
              if (errorMessage.toLowerCase().includes("conversation complete")) {
                return new Response(
                  JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
                  }),
                  { status: 200, headers: new Headers({ "content-type": "application/json" }) },
                )
              }
            } catch {}
          }

          if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = response.body.getReader()
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            const stream = new ReadableStream({
              async pull(ctrl) {
                const { done, value } = await reader.read()
                if (done) {
                  ctrl.close()
                  return
                }
                const text = decoder.decode(value, { stream: true })
                ctrl.enqueue(encoder.encode(text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')))
              },
              cancel() {
                reader.cancel()
              },
            })
            return new Response(stream, { headers: response.headers, status: response.status })
          }

          return response
        }
      }

      return {
        autoload: input.source === "config",
        options,
      }
    }),
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  auth: optional(Schema.Literals(["api", "oauth", "wellknown"])),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const Usage = Schema.Struct({
  providerID: ProviderV2.ID,
  turns: NonNegativeInt,
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
})
export type Usage = Schema.Schema.Type<typeof Usage>

export const QuotaWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Finite,
  resetAt: optional(NonNegativeInt),
  reset: optional(Schema.String),
  windowMinutes: optional(NonNegativeInt),
})
export type QuotaWindow = Schema.Schema.Type<typeof QuotaWindow>

export const Quota = Schema.Struct({
  providerID: ProviderV2.ID,
  status: Schema.Literals(["available", "unavailable", "error"]),
  source: Schema.Literals(["provider", "cli"]),
  plan: optional(Schema.String),
  detail: optional(Schema.String),
  windows: Schema.Array(QuotaWindow),
})
export type Quota = Schema.Schema.Type<typeof Quota>

export const UsageResult = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  providers: Schema.Array(Usage),
  quotas: Schema.Array(Quota),
})
export type UsageResult = Schema.Schema.Type<typeof UsageResult>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(
      {
        ...provider,
        key: undefined,
        options: publicOptions(provider.options),
        models: Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => Schema.is(Model)(model))
            .map(([id, model]) => [id, { ...model, options: publicOptions(model.options), headers: {} }]),
        ),
      },
      (_, value) => {
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
        if (typeof value === "bigint") return value.toString()
        return value
      },
    ),
  )
}

const SECRET_OPTION_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "headers",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "servicekey",
  "sessiontoken",
  "token",
  "accesskeyid",
])

function publicOptions(options: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(options).flatMap(([key, value]) => (secretOption(key) ? [] : [[key, publicOptionValue(value)]])),
  )
}

function publicOptionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicOptionValue)
  if (!value || typeof value !== "object") return value
  return publicOptions(value as Record<string, unknown>)
}

function secretOption(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  return (
    SECRET_OPTION_KEYS.has(normalized) ||
    normalized === "auth" ||
    normalized.includes("headers") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("secret") ||
    normalized === "key" ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  )
}

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return mapValues(providers, (item) => sort(Object.values(item.models))[0].id)
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  override get message() {
    return "No providers are available"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (
    model: Model,
    connectionPolicy?: ConnectionPolicy,
  ) => Effect.Effect<LanguageModelV3, ModelNotFoundError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
  readonly credentialFingerprint?: (providerID: ProviderV2.ID) => Effect.Effect<string>
}

type PolicyCacheEntry = {
  credential: string
  models: Set<string>
  sdks: Set<string>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  catalog: Record<ProviderV2.ID, Info>
  sdk: Map<string, { value: BundledSDK; close?: () => void }>
  authProviders: Set<ProviderV2.ID>
  policyCache: Map<string, PolicyCacheEntry>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
  discoveryLoaders: Record<string, CustomDiscoverModels>
  ollamaDiscoveryAt: number
  ollamaTemplate: Info | undefined
  ollamaWhitelist: readonly string[] | undefined
  ollamaBlacklist: readonly string[]
  ollamaDiscoveredModels: Set<string>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Provider") {}

export const use = serviceUse(Service)

function cost(c: ModelsDev.Model["cost"]): Model["cost"] {
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  const variants = ProviderTransform.reasoningVariants(model, base) ?? ProviderTransform.variants(base)

  return {
    ...base,
    variants: mapValues(variants, (v) => v),
  }
}

export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelsDevModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      const id = `${model.id}-${mode}`
      const base = fromModelsDevModel(provider, model)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? mergeDeep(base.cost, cost(opts.cost)) : base.cost,
        options: modeOptions(base, opts.provider?.body),
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

export function fromCatalogProvider(
  provider: ProviderV2.Info,
  models: readonly ModelV2.Info[],
  integration?: Integration.Info,
): Info {
  return {
    id: provider.id,
    name: provider.name,
    source: providerSource(integration),
    env: integration?.methods.flatMap((method) => (method.type === "env" ? method.names : [])) ?? [],
    options: publicOptions({
      ...(provider.api.settings ?? {}),
      ...provider.request.body,
      ...(provider.api.url ? { baseURL: provider.api.url } : {}),
    }),
    models: Object.fromEntries(
      models
        .filter((model) => model.providerID === provider.id && model.enabled)
        .map((model) => [model.id, fromCatalogModel(provider, model)]),
    ),
  }
}

function fromCatalogModel(provider: ProviderV2.Info, model: ModelV2.Info): Model {
  const api = model.api.type === "aisdk" ? model.api : provider.api.type === "aisdk" ? provider.api : undefined
  return {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: model.api.id,
      url: model.api.url ?? provider.api.url ?? "",
      npm: api?.package ?? "@ai-sdk/openai-compatible",
    },
    name: model.name,
    family: model.family,
    capabilities: {
      temperature: false,
      reasoning: model.variants.length > 0,
      attachment: model.capabilities.input.some((item) => item !== "text"),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
      interleaved: model.capabilities.interleaved ?? false,
    },
    cost: fromCatalogCost(model.cost),
    limit: model.limit,
    status: model.status,
    options: publicOptions(model.request.body),
    headers: {},
    release_date: model.time.released > 0 ? new Date(model.time.released).toISOString() : "",
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.body])),
  }
}

function fromCatalogCost(cost: ModelV2.Info["cost"]): Model["cost"] {
  const [base, ...tiers] = cost
  return {
    input: base?.input ?? 0,
    output: base?.output ?? 0,
    cache: {
      read: base?.cache.read ?? 0,
      write: base?.cache.write ?? 0,
    },
    tiers: tiers.flatMap((item) =>
      item.tier
        ? [
            {
              input: item.input,
              output: item.output,
              cache: { read: item.cache.read, write: item.cache.write },
              tier: item.tier,
            },
          ]
        : [],
    ),
  }
}

function modalities(values: readonly string[]): Schema.Schema.Type<typeof ProviderModalities> {
  return {
    text: values.includes("text"),
    audio: values.includes("audio"),
    image: values.includes("image"),
    video: values.includes("video"),
    pdf: values.includes("pdf"),
  }
}

function providerSource(integration: Integration.Info | undefined): Info["source"] {
  if (integration?.connections.some((connection) => connection.type === "env")) return "env"
  if (integration?.connections.length) return "api"
  return "custom"
}

export function normalizeOllamaEndpoint(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== "string") return
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : OLLAMA_DEFAULT_ENDPOINT
  const candidate = raw.includes("://") ? raw : `http://${raw}`

  try {
    const url = new URL(candidate)
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    if (url.username || url.password || url.search || url.hash) return

    const pathname = url.pathname.replace(/\/+$/, "")
    url.pathname = pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname || "/"
    return url.toString().replace(/\/$/, "")
  } catch {
    return
  }
}

export function ollamaModelsFromTags(input: unknown, endpoint = OLLAMA_DEFAULT_ENDPOINT): Record<string, Model> {
  if (!isRecord(input) || !Array.isArray(input.models)) return {}

  return Object.fromEntries(
    input.models.flatMap((item): Array<[string, Model]> => {
      const id = ollamaModelID(item)
      if (!id) return []
      const details = isRecord(item.details) ? item.details : undefined
      const family = typeof details?.family === "string" ? details.family : undefined
      const releaseDate = typeof item.modified_at === "string" ? item.modified_at : ""

      return [
        [
          id,
          {
            id: ModelV2.ID.make(id),
            providerID: ProviderV2.ID.make(OLLAMA_PROVIDER_ID),
            name: id,
            family,
            api: {
              id,
              url: `${endpoint}/v1`,
              npm: "@ai-sdk/openai-compatible",
            },
            status: "active",
            headers: {},
            options: {},
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: OLLAMA_DEFAULT_CONTEXT, output: OLLAMA_DEFAULT_OUTPUT },
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            release_date: releaseDate,
            variants: {},
          },
        ],
      ]
    }),
  )
}

function ollamaCatalogProvider(): Info {
  return {
    id: ProviderV2.ID.make(OLLAMA_PROVIDER_ID),
    source: "custom",
    name: "Ollama",
    env: [],
    options: {},
    models: {},
  }
}

function normalizeOllamaProvider(provider: Info) {
  const configuredBaseURL = provider.options.baseURL
  const firstModel = Object.values(provider.models)[0]
  const endpoint = normalizeOllamaEndpoint(configuredBaseURL ?? firstModel?.api.url)
  if (!endpoint) return false

  for (const model of Object.values(provider.models)) {
    if (!model.api.url) continue
    const modelEndpoint = normalizeOllamaEndpoint(model.api.url)
    if (!modelEndpoint || modelEndpoint !== endpoint) return false
  }

  provider.options.baseURL = `${endpoint}/v1`
  for (const model of Object.values(provider.models)) model.api.url = `${endpoint}/v1`
  return true
}

async function discoverOllamaModels(endpoint: string) {
  const response = await fetch(`${endpoint}/api/tags`, {
    redirect: "error",
    signal: AbortSignal.timeout(OLLAMA_DISCOVERY_TIMEOUT),
  }).catch(() => undefined)
  if (!response?.ok) return
  const body = await response.json().catch(() => undefined)
  if (!isRecord(body) || !Array.isArray(body.models)) return
  const models = ollamaModelsFromTags(body, endpoint)
  if (body.models.some((item) => !ollamaModelID(item))) return
  return models
}

function ollamaModelID(input: unknown) {
  if (!isRecord(input)) return
  const id = [input.name, input.model].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  )
  if (!id) return
  const normalized = id.trim()
  if (normalized === "__proto__" || normalized === "constructor" || normalized === "prototype") return
  return normalized
}

// Providers withheld from the runtime and suggestion catalogs. Empty today: OpenCode Go is still
// published by models.dev, so it is offered like any other catalog provider.
const removedProviders = new Set<string>()

export function isRemovedProvider(providerID: string) {
  return removedProviders.has(providerID)
}

const RETIRED_MOONSHOT_MODELS = new Set([
  "kimi-k2-0711-preview",
  "kimi-k2-0905-preview",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "kimi-k2-turbo-preview",
])

function modeOptions(model: Model, body: Record<string, unknown> | undefined) {
  if (!body) return model.options
  const options = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]),
  )
  const reasoning = body.reasoning
  if (model.api.npm !== "@ai-sdk/openai" || !isRecord(reasoning) || typeof reasoning.mode !== "string") return options
  const { reasoning: _, ...rest } = options
  return { ...rest, reasoningMode: reasoning.mode }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID, enableExperimentalModels: boolean) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => {
        const model = provider.models[id]
        if (model.status === "deprecated") return false
        if (model.status === "alpha" && !enableExperimentalModels) return false
        return true
      })
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const modelsDevSvc = yield* ModelsDev.Service
    const runtimeFlags = yield* RuntimeFlags.Service
    const modelStorage = yield* ModelStorage.make()

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const modelsDev = yield* modelsDevSvc.get()
        const catalog = mapValues(
          pickBy(modelsDev, (_, providerID) => !isRemovedProvider(providerID)),
          fromModelsDevProvider,
        )
        const claudeCode = ClaudeCodeProvider.info(modelsDev)
        catalog[ClaudeCodeProvider.ID] = claudeCode
        catalog[MuseCodeProvider.ID] = MuseCodeProvider.info(modelsDev)
        catalog[ProviderV2.ID.make(OLLAMA_PROVIDER_ID)] = ollamaCatalogProvider()
        const database = mapValues(catalog, toPublicInfo)

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const sdk = new Map<string, { value: BundledSDK; close?: () => void }>()
        const authProviders = new Set<ProviderV2.ID>()
        const policyCache: State["policyCache"] = new Map()
        const discoveryLoaders: {
          [providerID: string]: CustomDiscoverModels
        } = {}
        let ollamaDiscoveryAt = 0
        let ollamaTemplate: Info | undefined
        const ollamaDiscoveredModels = new Set<string>()
        const dep = {
          auth: (id: string) => auth.get(id).pipe(Effect.orDie),
          config: () => config.get(),
          env: () => env.all(),
          get: (key: string) => env.get(key),
        }

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, provider)
            return
          }
          const match = database[providerID]
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, provider)
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {})
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (isRemovedProvider(providerID)) return false
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          const models = p?.models
          if (!p || !models) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (disabled.has(providerID)) continue

          const provider = database[providerID]
          if (!provider) continue
          const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)

          provider.models = yield* Effect.promise(async () => {
            const next = await models(toPublicInfo(provider), { auth: pluginAuth })
            return Object.fromEntries(
              Object.entries(next).map(([id, model]) => [
                id,
                {
                  ...model,
                  id: ModelV2.ID.make(id),
                  providerID,
                },
              ]),
            )
          })
        }

        // extend database from config
        for (const [providerID, provider] of configProviders) {
          const existing = database[providerID]
          const parsed: Info = {
            id: ProviderV2.ID.make(providerID),
            name: provider.name ?? existing?.name ?? providerID,
            env: provider.env ?? existing?.env ?? [],
            options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
            source: "config",
            models: existing?.models ?? {},
          }

          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const existingModel = parsed.models[model.id ?? modelID]
            const apiID = model.id ?? existingModel?.api.id ?? modelID
            const apiNpm =
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible"
            const name = iife(() => {
              if (model.name) return model.name
              if (model.id && model.id !== modelID) return modelID
              return existingModel?.name ?? modelID
            })
            const parsedModel: Model = {
              id: ModelV2.ID.make(modelID),
              api: {
                id: apiID,
                npm: apiNpm,
                url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api ?? "",
              },
              status: model.status ?? existingModel?.status ?? "active",
              name,
              providerID: ProviderV2.ID.make(providerID),
              capabilities: {
                temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                input: {
                  text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                  audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                  image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                  video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                  pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                },
                output: {
                  text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                  audio:
                    model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                  image:
                    model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                  video:
                    model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                  pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                },
                interleaved:
                  model.interleaved ??
                  existingModel?.capabilities.interleaved ??
                  (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                    ? { field: "reasoning_content" }
                    : false),
              },
              cost: {
                input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
                output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
                cache: {
                  read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                  write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                },
              },
              options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
              limit: {
                context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                input: model.limit?.input ?? existingModel?.limit?.input,
                output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
              },
              headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
              family: model.family ?? existingModel?.family ?? "",
              release_date: model.release_date ?? existingModel?.release_date ?? "",
              variants: {},
            }
            const variants =
              existingModel?.api.npm === parsedModel.api.npm
                ? (existingModel.variants ?? ProviderTransform.variants(parsedModel))
                : ProviderTransform.variants(parsedModel)
            const merged = mergeDeep(variants, model.variants ?? {})
            parsedModel.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
            parsed.models[modelID] = parsedModel
          }
          database[providerID] = parsed
        }

        // load env
        const envs = yield* env.all()
        for (const [id, provider] of Object.entries(database)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: provider.env.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          authProviders.add(providerID)
          if (provider.type === "api") {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // plugin auth loader - database now has entries for config providers
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (disabled.has(providerID)) continue

          const stored = yield* auth.get(providerID).pipe(Effect.orDie)
          if (!stored) continue
          if (!plugin.auth.loader) continue

          const options = yield* Effect.promise(() =>
            plugin.auth!.loader!(
              () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
              toPublicInfo(database[plugin.auth!.provider]),
            ),
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        for (const [id, fn] of Object.entries(custom(dep))) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          const data = database[providerID]
          if (!data) {
            continue
          }
          const result = yield* fn(data)
          if (result && (result.autoload || providers[providerID])) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        const gitlab = ProviderV2.ID.make("gitlab")
        if (discoveryLoaders[gitlab] && providers[gitlab] && isProviderAllowed(gitlab)) {
          yield* Effect.promise(async () => {
            try {
              const discovered = await discoveryLoaders[gitlab]()
              if (!discovered) return
              for (const [modelID, model] of Object.entries(discovered)) {
                if (!providers[gitlab].models[modelID]) {
                  providers[gitlab].models[modelID] = model
                }
              }
            } catch (e) {}
          })
        }

        const ollama = ProviderV2.ID.make(OLLAMA_PROVIDER_ID)
        const discoverOllama = discoveryLoaders[ollama]
        if (discoverOllama && providers[ollama] && isProviderAllowed(ollama)) {
          ollamaDiscoveryAt = Date.now()
          const discovered = yield* Effect.promise(discoverOllama).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (discovered) {
            for (const [modelID, model] of Object.entries(discovered)) {
              if (!Object.hasOwn(providers[ollama].models, modelID)) {
                providers[ollama].models[modelID] = model
                ollamaDiscoveredModels.add(modelID)
              }
            }
          }
        }

        for (const [id, provider] of Object.entries(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            continue
          }

          if (providerID === ProviderV2.ID.make(OLLAMA_PROVIDER_ID) && !normalizeOllamaProvider(provider)) {
            delete providers[providerID]
            continue
          }
          if (providerID === ProviderV2.ID.make(OLLAMA_PROVIDER_ID)) ollamaTemplate = { ...provider, models: {} }

          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            model.api.id = model.api.id ?? model.id ?? modelID
            if (providerID === ProviderV2.ID.make("moonshotai") && RETIRED_MOONSHOT_MODELS.has(model.api.id)) {
              delete provider.models[modelID]
              continue
            }
            if (
              providerID === ProviderV2.ID.openai &&
              (!model.capabilities.toolcall || !model.capabilities.output.text || model.api.id.includes("realtime"))
            ) {
              delete provider.models[modelID]
              continue
            }
            if (
              // These chat aliases are invalid for the special handling in the
              // built-in providers below, but custom providers may support them.
              (modelID === "gpt-5-chat-latest" &&
                (providerID === ProviderV2.ID.openai ||
                  providerID === ProviderV2.ID.githubCopilot ||
                  providerID === ProviderV2.ID.openrouter)) ||
              (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat")
            )
              delete provider.models[modelID]
            if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) delete provider.models[modelID]
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (model.variants === undefined) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          if (Object.keys(provider.models).length === 0) {
            delete providers[providerID]
            continue
          }
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const cached of sdk.values()) cached.close?.()
            sdk.clear()
            languages.clear()
            policyCache.clear()
          }),
        )

        return {
          models: languages,
          providers,
          catalog,
          sdk,
          authProviders,
          policyCache,
          modelLoaders,
          varsLoaders,
          discoveryLoaders,
          ollamaDiscoveryAt,
          ollamaTemplate,
          ollamaWhitelist: cfg.provider?.[OLLAMA_PROVIDER_ID]?.whitelist,
          ollamaBlacklist: cfg.provider?.[OLLAMA_PROVIDER_ID]?.blacklist ?? [],
          ollamaDiscoveredModels,
        }
      }),
    )

    const list = Effect.fn("Provider.list")(function* () {
      const s = yield* InstanceState.get(state)
      const ollama = ProviderV2.ID.make(OLLAMA_PROVIDER_ID)
      const discoverOllama = s.discoveryLoaders[ollama]
      if (!discoverOllama || Date.now() - s.ollamaDiscoveryAt < OLLAMA_DISCOVERY_TTL) return s.providers

      s.ollamaDiscoveryAt = Date.now()
      const discovered = yield* Effect.promise(discoverOllama).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (discovered === undefined) return s.providers

      const template = s.ollamaTemplate ?? s.catalog[ollama]
      if (!template) return s.providers
      const existing = s.providers[ollama]
      for (const modelID of s.ollamaDiscoveredModels) {
        if (
          Object.hasOwn(discovered, modelID) &&
          !s.ollamaBlacklist.includes(modelID) &&
          (!s.ollamaWhitelist || s.ollamaWhitelist.includes(modelID))
        )
          continue
        if (existing) delete existing.models[modelID]
        s.ollamaDiscoveredModels.delete(modelID)
      }

      const eligible = Object.entries(discovered).filter(
        ([modelID]) =>
          !s.ollamaBlacklist.includes(modelID) && (!s.ollamaWhitelist || s.ollamaWhitelist.includes(modelID)),
      )
      if (!existing && eligible.length === 0) return s.providers

      const provider =
        existing ??
        (s.providers[ollama] = {
          ...template,
          options: { ...template.options, apiKey: template.options.apiKey ?? "ollama" },
          models: {},
        })
      for (const [modelID, model] of eligible) {
        if (s.ollamaDiscoveredModels.has(modelID) || !Object.hasOwn(provider.models, modelID)) {
          provider.models[modelID] = model
          s.ollamaDiscoveredModels.add(modelID)
        }
      }
      if (Object.keys(provider.models).length === 0 || !normalizeOllamaProvider(provider)) delete s.providers[ollama]
      return s.providers
    })

    async function resolveSDK(
      model: Model,
      s: State,
      envs: Record<string, string | undefined>,
      connectionPolicy?: ConnectionPolicy,
      currentAuth?: Auth.Info,
      credential?: string,
      policyCache?: PolicyCacheEntry,
      policyScope?: string,
      requiresLiveAuth = false,
    ) {
      try {
        const provider = s.providers[model.providerID]
        const options = { ...provider.options }

        if (
          model.providerID === "google-vertex" &&
          model.api.npm === "@ai-sdk/google-vertex/anthropic" &&
          !options.baseURL
        ) {
          const baseURL = googleVertexAnthropicBaseURL(
            typeof options.project === "string" ? options.project : undefined,
            typeof options.location === "string" ? options.location : undefined,
          )
          if (baseURL) options.baseURL = baseURL
        }

        if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
          delete options.fetch
        }

        if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
          options["includeUsage"] = true
        }

        const baseURL = iife(() => {
          let url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return

          const loader = s.varsLoaders[model.providerID]
          if (loader) {
            const vars = loader(options)
            for (const [key, value] of Object.entries(vars)) {
              const field = "${" + key + "}"
              url = url.replaceAll(field, value)
            }
          }

          url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
            const val = envs[String(key)]
            return val ?? item
          })
          return url
        })

        if (model.providerID === OLLAMA_PROVIDER_ID) {
          const endpoint = normalizeOllamaEndpoint(baseURL ?? model.api.url)
          if (!endpoint) throw new Error("Ollama requires a loopback HTTP endpoint")
          const forbidden = [
            "fetch",
            "proxy",
            "dispatcher",
            "agent",
            "httpAgent",
            "httpsAgent",
            "httpProxy",
            "httpsProxy",
          ]
          const override = forbidden.find((key) => options[key] !== undefined && options[key] !== false)
          if (override) throw new Error(`Ollama does not allow provider option: ${override}`)
          options["baseURL"] = `${endpoint}/v1`
        } else if (baseURL !== undefined) {
          options["baseURL"] = baseURL
        }
        if (connectionPolicy && currentAuth?.type === "api") options["apiKey"] = currentAuth.key
        if (connectionPolicy && currentAuth?.type === "oauth") options["apiKey"] = currentAuth.access
        if (connectionPolicy && currentAuth?.type === "wellknown") {
          options["apiKey"] = currentAuth.key
          options["token"] = currentAuth.token
        }
        if (options["apiKey"] === undefined && provider.key && (!connectionPolicy || !requiresLiveAuth || currentAuth))
          options["apiKey"] = provider.key
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }
        if (connectionPolicy) assertConnectionPolicyOptions(options)

        const identity = JSON.stringify({
          providerID: model.providerID,
          npm: model.api.npm,
          options,
          connectionPolicy: connectionPolicy ? connectionPolicyKey(connectionPolicy) : undefined,
          credential,
        })
        const key = connectionPolicy ? createHash("sha256").update(identity).digest("hex") : Hash.fast(identity)
        const existing = s.sdk.get(key)
        if (existing) {
          policyCache?.sdks.add(key)
          return existing.value
        }

        if (model.providerID === OLLAMA_PROVIDER_ID && options["fetch"] === false) delete options["fetch"]
        const customFetch = connectionPolicy
          ? createConnectionPolicyFetch(connectionPolicy)
          : typeof options["fetch"] === "function"
            ? options["fetch"]
            : undefined
        const chunkTimeout = options["chunkTimeout"]
        const headerTimeout = options["headerTimeout"]
        delete options["chunkTimeout"]
        delete options["headerTimeout"]

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = init ?? {}
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          const res = await fetchFn(
            input,
            connectionPolicy
              ? opts
              : {
                  ...opts,
                  ...(model.providerID === OLLAMA_PROVIDER_ID ? { redirect: "error" } : {}),
                  // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
                  timeout: false,
                },
          ).finally(() => headerTimeoutCtl?.clear())

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
        if (bundledLoader) {
          const factory = await bundledLoader()
          const loaded = factory({
            name: model.providerID,
            ...options,
          })
          if (policyCache && policyScope && s.policyCache.get(policyScope) !== policyCache) {
            customFetch.close?.()
            throw new ConnectionPolicyError("Connection policy credential changed during provider initialization")
          }
          const concurrent = s.sdk.get(key)
          if (concurrent) {
            customFetch.close?.()
            policyCache?.sdks.add(key)
            return concurrent.value as SDK
          }
          s.sdk.set(key, { value: loaded, close: connectionPolicy ? customFetch.close : undefined })
          policyCache?.sdks.add(key)
          return loaded as SDK
        }

        const installedPath = await (async () => {
          if (model.api.npm.startsWith("file://")) {
            return model.api.npm
          }
          const item = await Npm.add(model.api.npm)
          if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
          return item.entrypoint
        })()

        // `installedPath` is a local entry path or an existing `file://` URL. Normalize
        // only path inputs so Node on Windows accepts the dynamic import.
        const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        const mod = await import(importSpec)

        const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
        const loaded = fn({
          name: model.providerID,
          ...options,
        })
        if (policyCache && policyScope && s.policyCache.get(policyScope) !== policyCache) {
          customFetch.close?.()
          throw new ConnectionPolicyError("Connection policy credential changed during provider initialization")
        }
        const concurrent = s.sdk.get(key)
        if (concurrent) {
          customFetch.close?.()
          policyCache?.sdks.add(key)
          return concurrent.value as SDK
        }
        s.sdk.set(key, { value: loaded, close: connectionPolicy ? customFetch.close : undefined })
        policyCache?.sdks.add(key)
        return loaded as SDK
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      InstanceState.use(state, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) {
        const catalogProvider = s.catalog[providerID]
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, modelID, runtimeFlags.enableExperimentalModels)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalog, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }

      const info = Object.hasOwn(provider.models, modelID) ? provider.models[modelID] : undefined
      if (!info) {
        const current = modelSuggestions(provider, modelID, runtimeFlags.enableExperimentalModels)
        const suggestions = current.length
          ? current
          : modelSuggestions(s.catalog[providerID], modelID, runtimeFlags.enableExperimentalModels)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (
      model: Model,
      connectionPolicy?: ConnectionPolicy,
    ) {
      const s = yield* InstanceState.get(state)
      const envs = yield* env.all()
      const provider = s.providers[model.providerID]
      const policyKey = connectionPolicy ? connectionPolicyKey(connectionPolicy) : undefined
      const currentAuth = connectionPolicy ? yield* auth.get(model.providerID).pipe(Effect.orDie) : undefined
      if (connectionPolicy && currentAuth) s.authProviders.add(model.providerID)
      const credential = connectionPolicy
        ? createHash("sha256")
            .update(JSON.stringify(currentAuth ?? null))
            .digest("hex")
        : undefined
      if (connectionPolicy?.credentialHash && credential !== connectionPolicy.credentialHash)
        return yield* new ModelNotFoundError({
          modelID: model.id,
          providerID: model.providerID,
          cause: new Error("Provider credential changed after connection qualification"),
        })
      const policyScope = policyKey ? `${model.providerID}/${policyKey}` : undefined
      const previous = policyScope ? s.policyCache.get(policyScope) : undefined
      if (policyScope && previous && previous.credential !== credential) {
        for (const modelKey of previous.models) s.models.delete(modelKey)
        for (const sdkKey of previous.sdks) {
          s.sdk.get(sdkKey)?.close?.()
          s.sdk.delete(sdkKey)
        }
        s.policyCache.delete(policyScope)
      }
      const policyCache =
        policyScope && credential
          ? (s.policyCache.get(policyScope) ?? {
              credential,
              models: new Set<string>(),
              sdks: new Set<string>(),
            })
          : undefined
      if (policyScope && policyCache) s.policyCache.set(policyScope, policyCache)
      const key = connectionPolicy
        ? `${model.providerID}/${model.id}/${policyKey}/${credential}`
        : `${model.providerID}/${model.id}/default`
      policyCache?.models.add(key)
      if (s.models.has(key)) return s.models.get(key)!

      if (connectionPolicy && s.authProviders.has(model.providerID) && !currentAuth)
        return yield* Effect.die(new Error(`Provider ${model.providerID} credential was revoked`))
      return yield* EffectPromise.refineRejection(
        async () => {
          const sdk = await resolveSDK(
            model,
            s,
            envs,
            connectionPolicy,
            currentAuth,
            credential,
            policyCache,
            policyScope,
            s.authProviders.has(model.providerID),
          )
          const language = s.modelLoaders[model.providerID]
            ? await s.modelLoaders[model.providerID](
                sdk,
                model.api.id,
                {
                  ...provider.options,
                  ...model.options,
                },
                model,
              )
            : sdk.languageModel(model.api.id)
          if (policyCache && policyScope && s.policyCache.get(policyScope) !== policyCache)
            throw new ConnectionPolicyError("Connection policy credential changed during model initialization")
          s.models.set(key, language)
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderV2.ID) {
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
      }

      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        return {
          ...experimental.model,
          id: ModelV2.ID.make(experimental.model.id),
          providerID: ProviderV2.ID.make(experimental.model.providerID),
        }
      }

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return undefined
      }

      const priority = providerID.startsWith("opencode")
        ? ["gpt-nano"]
        : providerID.startsWith("github-copilot")
          ? ["gpt-mini", ...smallModelFamilyPriority]
          : smallModelFamilyPriority
      const models = sortBy(
        Object.values(provider.models),
        [(model) => model.release_date, "desc"],
        [(model) => model.id, "desc"],
      )
      for (const family of priority) {
        const candidates = models.filter((model) => model.family === family)
        if (providerID === ProviderV2.ID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]

          const globalMatch = candidates.find((model) => model.id.startsWith("global."))
          if (globalMatch) return globalMatch

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return regionalMatch
            }
          }

          const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((p) => model.id.startsWith(p)))
          if (unprefixed) return unprefixed
          continue
        }
        if (candidates[0]) return candidates[0]
      }

      return undefined
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      if (cfg.model) return parseModel(cfg.model)

      const s = yield* InstanceState.get(state)
      const recent = (yield* modelStorage.read().pipe(Effect.orDie)).recent
      for (const entry of recent) {
        const providerID = ProviderV2.ID.make(entry.providerID)
        const modelID = ModelV2.ID.make(entry.modelID)
        const provider = s.providers[providerID]
        if (!provider) continue
        if (!provider.models[modelID]) continue
        return { providerID, modelID }
      }

      const configured = Object.keys(cfg.provider ?? {})
      const provider = Object.values(s.providers).find((p) => configured.length === 0 || configured.includes(p.id))
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    const credentialFingerprint = Effect.fn("Provider.credentialFingerprint")(function* (providerID: ProviderV2.ID) {
      return createHash("sha256")
        .update(JSON.stringify((yield* auth.get(providerID).pipe(Effect.orDie)) ?? null))
        .digest("hex")
    })

    return Service.of({
      list,
      getProvider,
      getModel,
      getLanguage,
      closest,
      getSmallModel,
      defaultModel,
      credentialFingerprint,
    })
  }),
)

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Storage.node, Config.node, Auth.node, Env.node, Plugin.node, ModelsDev.node, RuntimeFlags.node],
})

export * as Provider from "./provider"
