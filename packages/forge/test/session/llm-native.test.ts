import { describe, expect, test } from "bun:test"
import { ToolFailure } from "@turenlabs/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@turenlabs/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { Provider } from "@/provider/provider"

import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
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
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {
    "x-model": "model-header",
  },
  release_date: "2026-01-01",
}

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

type NativeRequestInput = Parameters<typeof LLMNative.request>[0]

const sessionText = (text: string) => ({ type: "text" as const, text })

const sessionOpenAIReasoning = (
  text: string,
  options: {
    readonly storedAs: "providerMetadata" | "providerOptions"
    readonly itemId: string
    readonly encryptedContent: string | null
  },
) => {
  const metadata = {
    openai: { itemId: options.itemId, reasoningEncryptedContent: options.encryptedContent },
  }
  if (options.storedAs === "providerMetadata")
    return Object.assign({ type: "reasoning" as const, text }, { providerMetadata: metadata })
  return Object.assign({ type: "reasoning" as const, text }, { providerOptions: metadata })
}

type SessionAssistantPart = ReturnType<typeof sessionText> | ReturnType<typeof sessionOpenAIReasoning>

const storedSession = {
  user: (content: string): ModelMessage => ({ role: "user", content }),
  assistant: (content: SessionAssistantPart[]): ModelMessage => ({ role: "assistant", content }),
  text: sessionText,
  openaiReasoning: sessionOpenAIReasoning,
}

const openAIResponses = {
  user: (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }),
  assistant: (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
  openaiReasoning: (text: string, encryptedContent: string) => ({
    type: "reasoning",
    encrypted_content: encryptedContent,
    summary: [{ type: "summary_text", text }],
  }),
}

const prepareNativeRequest = (input: NativeRequestInput) => LLMClient.prepare(LLMNative.request(input))

const expectOpenAIResponsesRequest = (input: {
  readonly history: NativeRequestInput["messages"]
  readonly providerOptions?: NativeRequestInput["providerOptions"]
  readonly maxOutputTokens?: NativeRequestInput["maxOutputTokens"]
  readonly headers?: NativeRequestInput["headers"]
  readonly expectedBody: unknown
}) =>
  Effect.gen(function* () {
    expect(
      yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-openai-key",
        messages: input.history,
        providerOptions: input.providerOptions,
        maxOutputTokens: input.maxOutputTokens,
        headers: input.headers,
      }),
    ).toMatchObject({
      route: "openai-responses",
      protocol: "openai-responses",
      body: input.expectedBody,
    })
  })

describe("session.llm-native.request", () => {
  test("maps normalized stream inputs to a native LLM request", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "system from messages",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "file", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
            providerOptions: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ]

    const request = LLMNative.request({
      model: baseModel,
      system: ["agent system"],
      messages,
      tools: {
        bash: tool({
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          }),
        }),
      },
      toolChoice: "required",
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      providerOptions: { openai: { store: false } },
      headers: { "x-request": "request-header" },
    })

    expect(request.model).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      route: { id: "openai-responses" },
    })
    expect(request.model.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(request.model.route.defaults.headers).toEqual({
      "x-model": "model-header",
      "x-request": "request-header",
    })
    expect(request.model.route.defaults.limits).toMatchObject({
      context: 128_000,
      output: 32_000,
    })
    expect(request.system).toEqual([
      { type: "text", text: "agent system" },
      { type: "text", text: "system from messages" },
    ])
    expect(request.generation).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 1024,
    })
    expect(request.providerOptions).toEqual({ openai: { store: false } })
    expect(request.toolChoice).toMatchObject({ type: "required" })
    expect(request.tools).toMatchObject([
      {
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ])
    expect(request.messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerMetadata: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "media", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
            providerMetadata: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "bash",
            result: { type: "text", value: "ok" },
            providerMetadata: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ])
  })

  test("maps stored provider metadata to native content metadata", () => {
    const reasoning = Object.assign(
      { type: "reasoning" as const, text: "thinking" },
      {
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-state",
          },
        },
      },
    )
    const request = LLMNative.request({
      model: baseModel,
      messages: [
        {
          role: "assistant",
          content: [reasoning],
        },
      ],
    })

    expect(request.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
    ])
  })

  test("selects native request routes for provider packages", () => {
    const openai = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/openai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openai.route.id).toBe("openai-responses")
    expect(openai.route.endpoint.baseURL).toBe("https://api.openai.com/v1")

    const anthropic = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/anthropic" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(anthropic.route.endpoint.baseURL).toBe("https://api.anthropic.com/v1")

    const google = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/google" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(google.route.id).toBe("gemini")
    expect(google.route.endpoint.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")

    const compatible = LLMNative.model({
      model: {
        ...baseModel,
        api: { ...baseModel.api, url: "https://ai.example.test/v1", npm: "@ai-sdk/openai-compatible" },
      },
      apiKey: "test-key",
      messages: [],
    })
    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(compatible.route.endpoint.baseURL).toBe("https://ai.example.test/v1")

    const openrouter = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@openrouter/ai-sdk-provider" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openrouter.route.id).toBe("openrouter")
    expect(openrouter.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")
  })

  it.effect("native tool wrapper converts thrown errors into typed ToolFailure", () =>
    Effect.gen(function* () {
      const wrapped = LLMNativeRuntime.nativeTools(
        {
          explode: {
            description: "always throws",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new Error("boom")
            },
          } satisfies Tool,
        },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.explode.execute({}, { id: "call-1", name: "explode" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toBe("boom")
    }),
  )

  it.effect("native tool wrapper raises ToolFailure when the source tool has no execute handler", () =>
    Effect.gen(function* () {
      // The AI SDK Tool shape allows execute to be omitted (e.g., client-side / MCP tools).
      // The native runtime owns execution, so encountering such a tool here means upstream
      // wiring is wrong; we want a typed failure, not a silent skip or unhandled exception.
      const wrapped = LLMNativeRuntime.nativeTools(
        { incomplete: { description: "no execute", inputSchema: jsonSchema({ type: "object" }) } satisfies Tool },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.incomplete.execute({}, { id: "call-1", name: "incomplete" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("incomplete")
    }),
  )

  it.effect("compiles through the native OpenAI Responses route", () =>
    expectOpenAIResponsesRequest({
      history: [storedSession.user("hello")],
      providerOptions: { openai: { store: false, instructions: "You are concise." } },
      maxOutputTokens: 512,
      headers: { "x-request": "request-header" },
      expectedBody: {
        model: "gpt-5-mini",
        instructions: "You are concise.",
        input: [openAIResponses.user("hello")],
        max_output_tokens: 512,
        store: false,
        stream: true,
      },
    }),
  )

  it.effect("omits non-persisted OpenAI reasoning ids without encrypted state", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerOptions",
            itemId: "rs_1",
            encryptedContent: null,
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        store: false,
      },
    }),
  )

  it.effect("preserves encrypted OpenAI reasoning state through native request lowering", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.openaiReasoning("Checked the previous diff.", "encrypted-state"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("preserves empty encrypted OpenAI reasoning items before tool output", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
        ]),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [{ type: "reasoning", summary: [], encrypted_content: "encrypted-state" }],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("references stored OpenAI reasoning items by id", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: null,
          }),
        ]),
      ],
      providerOptions: { openai: { store: true } },
      expectedBody: {
        input: [{ type: "item_reference", id: "rs_1" }],
        store: true,
      },
    }),
  )
})
