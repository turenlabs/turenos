import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { GenerationOptions, LLM, mergeProviderOptions, type LLMRequest } from "../src"
import { AnthropicMessages, OpenAIChat } from "../src/protocols"
import { Auth, Endpoint, LLMClient, Route } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const TargetJson = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(TargetJson)

describe("request option precedence", () => {
  test("deep-merges provider option records and replaces arrays, primitives, and null", () => {
    const merged = mergeProviderOptions(
      {
        openai: {
          include: ["route"],
          metadata: { route: true, shared: "route" },
          nullable: "route",
          primitive: "route",
        },
      },
      {
        openai: {
          include: ["model"],
          metadata: { model: true, shared: "model" },
          nullable: null,
          primitive: "model",
        },
      },
      { openai: { metadata: { request: true }, primitive: false } },
    )

    expect(merged).toEqual({
      openai: {
        include: ["model"],
        metadata: { route: true, model: true, request: true, shared: "model" },
        nullable: null,
        primitive: false,
      },
    })
  })

  // `headers` runs inside prepareTransport on the request that compile resolved.
  const resolve = (
    defaults: Parameters<typeof Route.make>[0]["defaults"],
    request: Omit<Parameters<typeof LLM.request>[0], "model">,
  ) =>
    Effect.gen(function* () {
      const seen: LLMRequest[] = []
      const route = Route.make({
        id: "resolve-probe",
        provider: "openai",
        protocol: OpenAIChat.protocol,
        endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.openai.test/v1/" }),
        auth: Auth.none,
        transport: OpenAIChat.httpTransport,
        headers: (input) => {
          seen.push(input.request)
          return {}
        },
        defaults,
      })
      const input = LLM.request({ ...request, model: route.model({ id: "probe" }) })
      yield* LLMClient.prepare(input)
      return { input, resolved: seen[0] }
    })

  it.effect("keeps the request instance when no route or model option merges in", () =>
    Effect.gen(function* () {
      const bare = yield* resolve(undefined, { prompt: "Say hello." })
      expect(bare.resolved).toBe(bare.input)
      const own = yield* resolve(undefined, {
        prompt: "Say hello.",
        generation: { maxTokens: 5 },
        providerOptions: { openai: { store: true } },
        http: { headers: { "x-own": "1" } },
      })
      expect(own.resolved).toBe(own.input)
      expect(own.resolved?.generation).toEqual(new GenerationOptions({ maxTokens: 5 }))
    }),
  )

  it.effect("still merges route defaults under request options", () =>
    Effect.gen(function* () {
      const seen = yield* resolve(
        {
          generation: { maxTokens: 10, temperature: 1 },
          providerOptions: { openai: { store: false } },
          http: { headers: { "x-route": "route" } },
        },
        { prompt: "Say hello.", generation: { maxTokens: 5 } },
      )
      expect(seen.resolved).not.toBe(seen.input)
      expect(seen.resolved?.messages).toEqual(seen.input.messages)
      expect(seen.resolved?.generation).toEqual(new GenerationOptions({ maxTokens: 5, temperature: 1 }))
      expect(seen.resolved?.providerOptions).toEqual({ openai: { store: false } })
      expect(seen.resolved?.http?.headers).toEqual({ "x-route": "route" })
    }),
  )

  it.effect("prepares bodies with route defaults, model defaults, and call options in order", () =>
    Effect.gen(function* () {
      const route = OpenAIChat.route.with({
        endpoint: { baseURL: "https://api.openai.test/v1/" },
        auth: Auth.bearer("test"),
        generation: { maxTokens: 10, temperature: 1, stop: ["route"] },
        providerOptions: { openai: { store: false, reasoningEffort: "low" } },
      })
      const model = route.model({
        id: "gpt-4o-mini",
        defaults: {
          generation: { maxTokens: 20, temperature: 0.5, frequencyPenalty: 0.25, stop: ["model"] },
          providerOptions: { openai: { reasoningEffort: "medium" } },
        },
      })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Say hello.",
          generation: { maxTokens: 30, topP: 0.9, stop: ["request"] },
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body).toMatchObject({
        model: "gpt-4o-mini",
        stream: true,
        max_tokens: 30,
        temperature: 0.5,
        top_p: 0.9,
        frequency_penalty: 0.25,
        store: true,
        reasoning_effort: "medium",
      })
      expect(prepared.body.stop).toEqual(["request"])
    }),
  )

  it.effect("applies model HTTP defaults before request HTTP overlays", () =>
    LLMClient.generate(
      LLM.request({
        model: OpenAIChat.route
          .with({
            endpoint: { baseURL: "https://api.openai.test/v1/" },
            auth: Auth.bearer("fresh-key"),
            http: {
              body: { metadata: { route: true, shared: "route" }, value: "route" },
              headers: { "x-route": "route", "x-shared": "route" },
              query: { route: "1", shared: "route" },
            },
          })
          .model({
            id: "gpt-4o-mini",
            defaults: {
              http: {
                body: { metadata: { model: true, shared: "model" }, value: "model" },
                headers: { "x-model": "model", "x-shared": "model" },
                query: { model: "1", shared: "model" },
              },
            },
          }),
        prompt: "Say hello.",
        http: {
          body: { metadata: { request: true }, value: null },
          headers: { "x-request": "request" },
          query: { request: "1" },
        },
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?route=1&shared=model&model=1&request=1")
            expect(web.headers.get("authorization")).toBe("Bearer fresh-key")
            expect(web.headers.get("x-route")).toBe("route")
            expect(web.headers.get("x-model")).toBe("model")
            expect(web.headers.get("x-request")).toBe("request")
            expect(web.headers.get("x-shared")).toBe("model")
            expect(decodeJson(input.text)).toMatchObject({
              metadata: { route: true, model: true, request: true, shared: "model" },
              value: null,
            })
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("rejects raw body overlays for protocol-owned roots", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          prompt: "Say hello.",
          http: { body: { model: "gpt-5", messages: [], tools: [] } },
        }),
      ).pipe(Effect.flip)

      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "http.body cannot overlay protocol-owned field(s): model, messages, tools",
      })
    }),
  )

  it.effect("uses model output limits after route limits and before call maxTokens", () =>
    Effect.gen(function* () {
      const route = AnthropicMessages.route.with({
        endpoint: { baseURL: "https://api.anthropic.test/v1/" },
        auth: Auth.header("x-api-key", "test"),
        limits: { output: 128 },
      })
      const model = route.model({ id: "claude-sonnet-4-5", defaults: { limits: { output: 64 } } })
      const withoutMaxTokens = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({ model, prompt: "Say hello.", cache: "none" }),
      )
      const withMaxTokens = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({ model, prompt: "Say hello.", cache: "none", generation: { maxTokens: 32 } }),
      )

      expect(withoutMaxTokens.body.max_tokens).toBe(64)
      expect(withMaxTokens.body.max_tokens).toBe(32)
    }),
  )
})
