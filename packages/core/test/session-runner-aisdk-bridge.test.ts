import { describe, expect } from "bun:test"
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { LLM, Message, ToolCallPart, ToolDefinition } from "@turenlabs/llm"
import { ProviderShared } from "@turenlabs/llm/protocols"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AISDK } from "@turenlabs/core/aisdk"
import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/core/integration"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AISDKBridge } from "@turenlabs/core/session/runner/aisdk-bridge"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionRunnerRetry } from "@turenlabs/core/session/runner/retry"
import { Tool } from "@turenlabs/core/tool/tool"
import { it } from "./lib/effect"

const catalogModel = (apiKey?: string) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("command-r"),
    providerID: ProviderV2.ID.make("cohere"),
    name: "Command R",
    api: {
      id: ModelV2.ID.make("command-r"),
      type: "aisdk",
      package: "@ai-sdk/cohere",
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-fixture": "bridge" },
      body: {
        ...(apiKey ? { apiKey } : {}),
        temperature: 0.25,
      },
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 8_000 },
  })

const routedModel = (providerID: string, packageName: string) =>
  ModelV2.Info.make({
    ...catalogModel(),
    providerID: ProviderV2.ID.make(providerID),
    api: {
      id: ModelV2.ID.make("routed-model"),
      type: "aisdk",
      package: packageName,
    },
    request: { headers: {}, body: {} },
  })

const usage = {
  inputTokens: { total: 11, noCache: 9, cacheRead: 2, cacheWrite: 0 },
  outputTokens: { total: 7, text: 5, reasoning: 2 },
}

const protectedSecrets = {
  apiKey: "bridge-secret-12345",
  header: "header-token-67890",
  accessKey: "AKIAFIXTURE123456",
  secretKey: "aws-secret-abcdef123456",
  settings: "settings-token-24680",
  query: "query-signature-13579/+",
}

const protectedCatalogModel = () =>
  ModelV2.Info.make({
    ...catalogModel(),
    api: {
      ...catalogModel().api,
      url: `https://provider.example/v1?signature=${encodeURIComponent(protectedSecrets.query)}`,
      settings: { credentials: { token: protectedSecrets.settings } },
    },
    request: {
      headers: { authorization: `Bearer ${protectedSecrets.header}` },
      body: {
        apiKey: protectedSecrets.apiKey,
        credentials: {
          accessKeyId: protectedSecrets.accessKey,
          secretAccessKey: protectedSecrets.secretKey,
        },
      },
    },
  })

const streamParts = (): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "source", sourceType: "url", id: "source-1", url: "https://evidence.example", title: "Evidence" },
  { type: "file", mediaType: "image/png", data: "AAEC" },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Inspecting." },
  { type: "text-end", id: "text-1" },
  { type: "tool-input-start", id: "call-1", toolName: "strings" },
  { type: "tool-input-delta", id: "call-1", delta: '{"needle":"forge"}' },
  { type: "tool-input-end", id: "call-1" },
  { type: "tool-call", toolCallId: "call-1", toolName: "strings", input: '{"needle":"forge"}' },
  { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
]

const language = (
  token: string,
  calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }>,
  canceled?: { value: boolean },
  started?: Deferred.Deferred<void>,
): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "fixture",
  modelId: "command-r",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("Fixture only supports streaming")
  },
  doStream: async (options) => {
    calls.push({ token, options })
    const pulls = { value: 0 }
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          if (started) return
          streamParts().forEach((part) => controller.enqueue(part))
          if (!canceled) controller.close()
        },
        pull(controller) {
          if (!started) return
          pulls.value += 1
          if (pulls.value === 1) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            return
          }
          Deferred.doneUnsafe(started, Effect.void)
          return new Promise<void>(() => undefined)
        },
        cancel() {
          if (canceled) canceled.value = true
        },
      }),
    }
  },
})

const fixtureLanguage = (doStream: LanguageModelV3["doStream"]): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "fixture",
  modelId: "command-r",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("Fixture only supports streaming")
  },
  doStream,
})

const clientLayer = LLMClient.layer.pipe(Layer.provide(Layer.mock(RequestExecutor.Service, {})))

describe("SessionRunnerModel AI SDK bridge", () => {
  it.effect("streams one real LanguageModelV3 call with structured tools and normalized events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          const token = typeof event.options.apiKey === "string" ? event.options.apiKey : "missing"
          event.sdk = { languageModel: () => language(token, calls) }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          catalogModel(),
          Credential.Key.make({ type: "key", key: "token-a", metadata: { tenant: "must-not-project" } }),
        )
        const reviewRequest = Tool.make({
          description: "Request review.",
          input: Schema.Struct({ request: Schema.String }).annotate({ identifier: "ReviewRequest" }),
          output: Schema.Struct({ queued: Schema.Boolean }),
          execute: () => Effect.succeed({ queued: true }),
        })
        const request = LLM.request({
          model: resolved,
          prompt: "Find the Forge marker.",
          tools: [
            ToolDefinition.make({
              name: "strings",
              description: "Search bounded strings",
              inputSchema: {
                type: "object",
                properties: { needle: { type: "string" } },
                required: ["needle"],
              },
            }),
            ToolDefinition.make({
              name: "list_agents",
              description: "List bounded child agents",
              inputSchema: Schema.toJsonSchemaDocument(Schema.Struct({})).schema,
            }),
            Tool.definition("harness_review_request", reviewRequest),
          ],
        })
        const events = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(clientLayer))

        expect(resolved.route.id).toBe("aisdk-language-model-v3")
        expect(calls).toHaveLength(1)
        expect(calls[0]?.token).toBe("token-a")
        expect(calls[0]?.options.temperature).toBe(0.25)
        expect(calls[0]?.options.tools?.[0]).toMatchObject({ type: "function", name: "strings" })
        expect(calls[0]?.options.tools?.[1]).toMatchObject({
          type: "function",
          name: "list_agents",
          inputSchema: { type: "object" },
        })
        const bridgedReviewTool = calls[0]?.options.tools?.[2]
        expect(bridgedReviewTool).toMatchObject({
          type: "function",
          name: "harness_review_request",
          inputSchema: {
            type: "object",
            properties: { request: { type: "string" } },
            required: ["request"],
          },
        })
        if (bridgedReviewTool?.type !== "function") throw new Error("expected function tool")
        expect("$ref" in bridgedReviewTool.inputSchema).toBe(false)
        expect(calls[0]?.options.prompt.at(-1)).toMatchObject({ role: "user" })
        expect(events.map((event) => event.type)).toEqual([
          "step-start",
          "text-start",
          "text-delta",
          "text-end",
          "tool-input-start",
          "tool-input-delta",
          "tool-input-end",
          "tool-call",
          "step-finish",
          "finish",
        ])
        expect(events.find((event) => event.type === "tool-call")).toMatchObject({
          input: { needle: "forge" },
        })
        expect(JSON.stringify(calls[0]?.options)).not.toContain("must-not-project")
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("rebinds rotated credentials and evicts the prior logical cache entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const created: string[] = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          const token = typeof event.options.apiKey === "string" ? event.options.apiKey : "missing"
          created.push(token)
          event.sdk = { languageModel: () => language(token, calls) }
        })
        const first = yield* aisdk.language(catalogModel("token-a"))
        const repeated = yield* aisdk.language(catalogModel("token-a"))
        const second = yield* aisdk.language(catalogModel("token-b"))
        const rebound = yield* aisdk.language(catalogModel("token-a"))

        expect(repeated).toBe(first)
        expect(second).not.toBe(first)
        expect(rebound).not.toBe(first)
        expect(created).toEqual(["token-a", "token-b", "token-a"])
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("cancels the provider ReadableStream and aborts the provider request when the bridge consumer stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const canceled = { value: false }
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language("token", calls, canceled) }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))

        yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Cancel." })).pipe(
          Stream.take(1),
          Stream.runDrain,
          Effect.provide(clientLayer),
        )

        expect(calls).toHaveLength(1)
        expect(canceled.value).toBe(true)
        expect(calls[0]?.options.abortSignal?.aborted).toBe(true)
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("aborts the provider request when the bridge consumer is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const canceled = { value: false }
        const started = Deferred.makeUnsafe<void>()
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language("token", calls, canceled, started) }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))
        const fiber = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Interrupt." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.forkScoped,
        )

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)

        expect(calls).toHaveLength(1)
        expect(calls[0]?.options.abortSignal?.aborted).toBe(true)
        expect(canceled.value).toBe(true)
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("does not persist configured credentials echoed by provider call or raw-output failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = { value: 0 }
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = {
            languageModel: () =>
              fixtureLanguage(async () => {
                calls.value += 1
                if (calls.value === 1)
                  throw new APICallError({
                    message: `Provider echoed ${Object.values(protectedSecrets).join(" ")}`,
                    url: protectedCatalogModel().api.url!,
                    requestBodyValues: {},
                    statusCode: 400,
                    responseBody: protectedSecrets.apiKey,
                  })
                return {
                  stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: "call-secret",
                        toolName: "strings",
                        input: `not-json ${Object.values(protectedSecrets).join(" ")} ${encodeURIComponent(protectedSecrets.query)}`,
                      })
                      controller.close()
                    },
                  }),
                }
              }),
          }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(protectedCatalogModel())
        const callFailure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Fail safely." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )
        const rawFailure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Fail raw safely." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )
        const persisted = `${callFailure.message}\n${JSON.stringify(callFailure)}\n${rawFailure.message}\n${JSON.stringify(rawFailure)}`

        expect(callFailure.message).toContain("status 400")
        expect(rawFailure.message).toContain("invalid tool-call JSON")
        Object.values(protectedSecrets)
          .flatMap((secret) => [secret, encodeURIComponent(secret)])
          .forEach((secret) => expect(persisted).not.toContain(secret))
        expect(persisted).toContain("[REDACTED]")
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("treats a provider HTTP 400 as terminal even when the SDK marks it retryable", () =>
    Effect.gen(function* () {
      const resolved = AISDKBridge.model({
        language: fixtureLanguage(async () => {
          throw new APICallError({
            message: "Bad Request",
            url: "https://cli-chat-proxy.grok.com/v1/responses",
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: true,
            responseBody: JSON.stringify({
              error: { code: "invalid_request_error", message: "invalid Grok request" },
            }),
          })
        }),
        model: routedModel("xai", "@ai-sdk/xai"),
        defaults: {},
      })
      const failure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Use Grok 4.6." })).pipe(
        Stream.runDrain,
        Effect.provide(clientLayer),
        Effect.flip,
      )

      expect(failure.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: expect.stringContaining("invalid Grok request"),
      })
      expect(failure.retryable).toBe(false)
      expect(SessionRunnerRetry.decide({ failure, attempt: 0, now: 0 })).toBeUndefined()
    }),
  )

  it.effect("treats an in-stream provider HTTP 400 as terminal", () =>
    Effect.gen(function* () {
      const resolved = AISDKBridge.model({
        language: fixtureLanguage(async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({
                type: "error",
                error: new APICallError({
                  message: "Bad Request",
                  url: "https://cli-chat-proxy.grok.com/v1/responses",
                  requestBodyValues: {},
                  statusCode: 400,
                  isRetryable: true,
                  responseBody: JSON.stringify({ error: { message: "invalid Grok stream request" } }),
                }),
              })
              controller.close()
            },
          }),
        })),
        model: routedModel("xai", "@ai-sdk/xai"),
        defaults: {},
      })
      const failure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Use Grok 4.6." })).pipe(
        Stream.runDrain,
        Effect.provide(clientLayer),
        Effect.flip,
      )

      expect(failure.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(failure.retryable).toBe(false)
    }),
  )

  it.effect("keeps transient 408 and 425 provider failures retryable", () =>
    Effect.gen(function* () {
      for (const status of [408, 425]) {
        const resolved = AISDKBridge.model({
          language: fixtureLanguage(async () => {
            throw new APICallError({
              message: `Provider timeout ${status}`,
              url: "https://cli-chat-proxy.grok.com/v1/responses",
              requestBodyValues: {},
              statusCode: status,
              isRetryable: false,
            })
          }),
          model: routedModel("xai", "@ai-sdk/xai"),
          defaults: {},
        })
        const failure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Use Grok 4.6." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )

        expect(failure.reason).toMatchObject({ _tag: "ProviderInternal", status })
        expect(failure.retryable).toBe(true)
      }
    }),
  )

  it.effect("genericizes provider type:error and reader rejection messages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const typeErrorSecret = "type-error-secret-12345"
        const readerSecret = "reader-error-secret-67890"
        const calls = { value: 0 }
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = {
            languageModel: () =>
              fixtureLanguage(async () => {
                calls.value += 1
                if (calls.value === 1)
                  return {
                    stream: new ReadableStream<LanguageModelV3StreamPart>({
                      start(controller) {
                        controller.enqueue({ type: "error", error: new Error(typeErrorSecret) })
                        controller.close()
                      },
                    }),
                  }
                return {
                  stream: new ReadableStream<LanguageModelV3StreamPart>({
                    pull() {
                      throw new Error(readerSecret)
                    },
                  }),
                }
              }),
          }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))
        const typeFailure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Type error." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )
        const readerFailure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Reader error." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )
        const persisted = `${typeFailure.message}\n${JSON.stringify(typeFailure)}\n${readerFailure.message}\n${JSON.stringify(readerFailure)}`

        expect(typeFailure.message).toContain("Provider response stream failed")
        expect(readerFailure.message).toContain("Provider response stream failed")
        expect(persisted).not.toContain(typeErrorSecret)
        expect(persisted).not.toContain(readerSecret)
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("maps transient OpenAI call and reader rejections to retryable provider failures", () =>
    Effect.gen(function* () {
      const longSecret = `sk-${"secret".repeat(200)}`
      const errors = [
        `server_error: An error occurred while processing your request. Please include request ID req_call. ${longSecret}`,
        "server_is_overloaded: Our servers are currently overloaded. Please include request ID req_reader.",
      ]
      const calls = { value: 0 }
      const resolved = AISDKBridge.model({
        language: fixtureLanguage(async () => {
          const error = errors[calls.value++]!
          if (calls.value === 1)
            throw new APICallError({
              message: error,
              url: "https://api.openai.com/v1/responses",
              requestBodyValues: {},
              statusCode: 503,
              responseHeaders: { "retry-after": "60" },
              responseBody: JSON.stringify({ error: { code: "server_error", message: error } }),
            })
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              pull() {
                throw new Error(error)
              },
            }),
          }
        }),
        model: ModelV2.Info.make({
          ...routedModel("openai", "@ai-sdk/openai"),
          request: { headers: {}, body: { apiKey: longSecret } },
        }),
        defaults: {},
      })
      const callFailure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Retry call error." })).pipe(
        Stream.runDrain,
        Effect.provide(clientLayer),
        Effect.flip,
      )
      const readerFailure = yield* LLMClient.stream(
        LLM.request({ model: resolved, prompt: "Retry reader error." }),
      ).pipe(Stream.runDrain, Effect.provide(clientLayer), Effect.flip)

      expect(callFailure.reason).toMatchObject({
        _tag: "ProviderInternal",
        message: expect.stringContaining("req_call. [REDACTED]"),
        status: 503,
        retryAfterMs: 60_000,
      })
      expect(JSON.stringify(callFailure.reason)).not.toContain(longSecret.slice(0, 100))
      expect(readerFailure.reason).toMatchObject({
        _tag: "ProviderInternal",
        message: expect.stringContaining("req_reader"),
      })
      expect(callFailure.retryable).toBe(true)
      expect(readerFailure.retryable).toBe(true)
      expect(SessionRunnerRetry.decide({ failure: callFailure, attempt: 0, now: 0 })).toMatchObject({
        attempt: 1,
        delay: 60_000,
      })
      expect(SessionRunnerRetry.decide({ failure: readerFailure, attempt: 0, now: 0 })).toMatchObject({
        attempt: 1,
        delay: 2_000,
      })
    }),
  )

  it.effect("surfaces an error finish reason as a failed provider response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = {
            languageModel: () =>
              fixtureLanguage(async () => ({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] })
                    controller.enqueue({
                      type: "finish",
                      usage,
                      finishReason: { unified: "error", raw: "upstream_response_failed" },
                    })
                    controller.close()
                  },
                }),
              })),
          }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))
        const events = Array.from(
          yield* LLM.stream(LLM.request({ model: resolved, prompt: "Fail visibly." })).pipe(
            Stream.runCollect,
            Effect.provide(clientLayer),
          ),
        )

        expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
        expect(events.at(-1)).toMatchObject({
          type: "provider-error",
          message: "Provider response failed: upstream_response_failed",
        })
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("marks transient OpenAI error finish reasons retryable", () =>
    Effect.gen(function* () {
      const resolved = AISDKBridge.model({
        language: fixtureLanguage(async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({
                type: "finish",
                usage,
                finishReason: {
                  unified: "error",
                  raw: "server_error: An error occurred while processing your request. Please include request ID req_123.",
                },
              })
              controller.close()
            },
          }),
        })),
        model: routedModel("openai", "@ai-sdk/openai"),
        defaults: {},
      })
      const events = Array.from(
        yield* LLM.stream(LLM.request({ model: resolved, prompt: "Retry transient errors." })).pipe(
          Stream.runCollect,
          Effect.provide(clientLayer),
        ),
      )

      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        retryable: true,
        message: expect.stringContaining("req_123"),
      })
    }),
  )

  it.effect("recognizes OpenAI transient stream errors in every AI SDK shape", () =>
    Effect.sync(() => {
      expect(
        AISDKBridge.retryableOpenAIStreamErrorCode(
          new Error("server_is_overloaded: Our servers are currently overloaded. Please try again later."),
        ),
      ).toBe("server_is_overloaded")
      expect(AISDKBridge.retryableOpenAIStreamErrorCode(new Error("server_error: temporary failure"))).toBe(
        "server_error",
      )
      expect(AISDKBridge.retryableOpenAIStreamErrorCode(new Error("server_error"))).toBe("server_error")
      expect(AISDKBridge.retryableOpenAIStreamErrorCode("rate_limit_exceeded: Slow down")).toBe("rate_limit_exceeded")
      expect(
        AISDKBridge.retryableOpenAIStreamErrorCode({
          type: "error",
          error: { type: "internal_server_error", message: "Please try again later." },
        }),
      ).toBe("internal_server_error")
      expect(
        AISDKBridge.retryableOpenAIStreamErrorCode(new Error("invalid request: server_error: unsupported option")),
      ).toBeUndefined()
      expect(
        AISDKBridge.retryableOpenAIStreamErrorCode({
          type: "error",
          error: { type: "authentication_error", message: "Invalid key, please try again later." },
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("leaves overload errors from non-OpenAI bridge providers terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = {
            languageModel: () =>
              fixtureLanguage(async () => ({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  start(controller) {
                    controller.enqueue({
                      type: "error",
                      error: new Error(
                        "server_is_overloaded: Our servers are currently overloaded. Please try again later.",
                      ),
                    })
                    controller.close()
                  },
                }),
              })),
          }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))
        const failure = yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Retry overload." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
          Effect.flip,
        )

        expect(failure.message).toContain("Provider response stream failed")
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("continues immutable tool-result files as bounded AI SDK file-data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language("token", calls) }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))

        yield* LLMClient.stream(
          LLM.request({
            model: resolved,
            messages: [
              Message.assistant([ToolCallPart.make({ id: "call-image", name: "read", input: { path: "pixel.png" } })]),
              Message.tool({
                id: "call-image",
                name: "read",
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "Pixel" },
                    { type: "file", uri: "data:image/png;base64,AAEC", mime: "image/png", name: "pixel.png" },
                  ],
                },
              }),
            ],
          }),
        ).pipe(Stream.runDrain, Effect.provide(clientLayer))

        expect(calls[0]?.options.prompt.at(-1)).toMatchObject({
          role: "tool",
          content: [
            {
              type: "tool-result",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Pixel" },
                  {
                    type: "file-data",
                    data: "AAEC",
                    mediaType: "image/png",
                    filename: "pixel.png",
                  },
                ],
              },
            },
          ],
        })
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("rejects remote, malformed, and oversized request media before invoking the provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language("token", calls) }
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(catalogModel("token"))
        const invalid = [
          {
            mediaType: "image/png",
            data: "https://untrusted.example/image.png",
            message: "valid base64",
          },
          {
            mediaType: "not a media type",
            data: "AAEC",
            message: "invalid media type",
          },
          {
            mediaType: "image/png",
            data: "A".repeat(ProviderShared.MAX_MEDIA_ENCODED_BYTES + 4),
            message: "encoded limit",
          },
        ]

        yield* Effect.forEach(
          invalid,
          Effect.fn(function* (media) {
            const error = yield* LLMClient.stream(
              LLM.request({
                model: resolved,
                messages: [Message.user({ type: "media", mediaType: media.mediaType, data: media.data })],
              }),
            ).pipe(Stream.runDrain, Effect.provide(clientLayer), Effect.flip)
            expect(error.message).toContain(media.message)
          }),
          { discard: true },
        )
        expect(calls).toEqual([])
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("rejects unsafe no-URL facades before provider hooks see credentials or prompts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialized: string[] = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          initialized.push(`${event.model.providerID}:${String(event.options.apiKey)}`)
          event.sdk = { languageModel: () => language("unexpected", []) }
        })
        const credential = Credential.Key.make({ type: "key", key: "must-not-leak" })
        const github = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          routedModel("github-copilot", "@ai-sdk/github-copilot"),
          credential,
        ).pipe(Effect.flip)
        const cloudflare = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          routedModel("cloudflare-ai-gateway", "@ai-sdk/anthropic"),
          credential,
        ).pipe(Effect.flip)

        expect(github._tag).toBe("SessionRunnerModel.UnsupportedApiError")
        expect(cloudflare._tag).toBe("SessionRunnerModel.UnsupportedApiError")
        expect(initialized).toEqual([])
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("qualifies current bridge packages only for their exact provider IDs and preserves call options", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language(event.model.providerID, calls) }
        })
        const aihubmixModel = routedModel("aihubmix", "@aihubmix/ai-sdk-provider")
        const mergeModel = routedModel("merge-gateway", "merge-gateway-ai-sdk-provider")
        const aihubmix = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          ModelV2.Info.make({
            ...aihubmixModel,
            request: { headers: {}, body: { service_tier: "priority" } },
          }),
          Credential.Key.make({ type: "key", key: "aihubmix-token" }),
        )
        const merge = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          ModelV2.Info.make({
            ...mergeModel,
            request: { headers: {}, body: { service_tier: "priority", speed: "fast" } },
          }),
          Credential.Key.make({ type: "key", key: "merge-token" }),
        )
        yield* LLMClient.stream(LLM.request({ model: aihubmix, prompt: "AIHubMix." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
        )
        yield* LLMClient.stream(LLM.request({ model: merge, prompt: "Merge." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
        )

        expect(aihubmix.route.id).toBe("aisdk-language-model-v3")
        expect(merge.route.id).toBe("aisdk-language-model-v3")
        expect(calls[0]?.options.providerOptions).toEqual({ aihubmix: { service_tier: "priority" } })
        expect(calls[1]?.options.providerOptions).toEqual({
          "merge-gateway": { service_tier: "priority", speed: "fast" },
        })
        expect(SessionRunnerModel.supported(routedModel("other", "@aihubmix/ai-sdk-provider"))).toBe(false)
        expect(SessionRunnerModel.supported(routedModel("other", "merge-gateway-ai-sdk-provider"))).toBe(false)
        expect(
          SessionRunnerModel.supported(routedModel("google-vertex-anthropic", "@ai-sdk/google-vertex/anthropic")),
        ).toBe(true)
        expect(SessionRunnerModel.supported(routedModel("other", "@ai-sdk/google-vertex/anthropic"))).toBe(false)
        expect(SessionRunnerModel.supported(routedModel("azure-cognitive-services", "@ai-sdk/azure"))).toBe(true)
        expect(SessionRunnerModel.supported(routedModel("v0", "@ai-sdk/vercel"))).toBe(true)
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("routes the current GitHub Copilot OAuth catalog entry and rejects the legacy no-URL facade", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialized: Array<{ readonly packageName: string; readonly options: Record<string, unknown> }> = []
        const calls: Array<{ readonly token: string; readonly options: LanguageModelV3CallOptions }> = []
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          initialized.push({ packageName: event.package, options: event.options })
          event.sdk = { languageModel: () => language(String(event.options.apiKey), calls) }
        })
        const current = routedModel("github-copilot", "@ai-sdk/openai-compatible")
        const credential = Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("github-copilot"),
          access: "copilot-oauth-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        })
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          ModelV2.Info.make({
            ...current,
            api: { ...current.api, url: "https://api.githubcopilot.com" },
          }),
          credential,
        )
        yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Inspect." })).pipe(
          Stream.runDrain,
          Effect.provide(clientLayer),
        )
        const legacy = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          routedModel("github-copilot", "@ai-sdk/github-copilot"),
          credential,
        ).pipe(Effect.flip)

        expect(resolved.route.id).toBe("aisdk-language-model-v3")
        expect(initialized).toHaveLength(1)
        expect(initialized[0]).toMatchObject({
          packageName: "@ai-sdk/openai-compatible",
          options: { apiKey: "copilot-oauth-token", baseURL: "https://api.githubcopilot.com" },
        })
        expect(calls).toHaveLength(1)
        expect(legacy._tag).toBe("SessionRunnerModel.UnsupportedApiError")
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )

  it.effect("routes a long-tail package with an explicit qualified endpoint through the AI SDK bridge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = { languageModel: () => language("custom-token", []) }
        })
        const custom = routedModel("custom-cohere", "@ai-sdk/cohere")
        const resolved = yield* SessionRunnerModel.fromCatalogModelWithAISDK(
          ModelV2.Info.make({
            ...custom,
            api: { ...custom.api, url: "https://cohere-proxy.example/v1" },
          }),
          Credential.Key.make({ type: "key", key: "custom-token" }),
        )

        expect(resolved.route.id).toBe("aisdk-language-model-v3")
      }).pipe(Effect.provide(AISDK.locationLayer)),
    ),
  )
})
