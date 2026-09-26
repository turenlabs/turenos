import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LLM, LLMError, Message, ToolCallPart } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenRouter from "../../src/providers/openrouter"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { deltaChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const gemini = OpenRouter.configure({ apiKey: "fixture" }).model("google/gemini-3.8-flash")

const tools = [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object" } }]

// Shapes observed live on OpenRouter (google/gemini-3.8-flash, anthropic/claude-haiku-4.5):
// reasoning text streams as `delta.reasoning` mirrored by `reasoning.text` detail chunks that
// share one index, the signature arrives on a trailing text-less chunk, and a Gemini tool-call
// turn can carry only an opaque `reasoning.encrypted` block.
const textDetail = (text: string) => ({ type: "reasoning.text", text, format: "anthropic-claude-v1", index: 0 })

// An SSE response whose body the test writes chunk by chunk, so idle gaps are measured on the
// TestClock instead of wall time.
const controlledStream = () => {
  const encoder = new TextEncoder()
  const body = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
  return {
    layer: dynamicResponse((input) =>
      Effect.succeed(
        input.respond(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body.controller = controller
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
    write: (text: string) => body.controller?.enqueue(encoder.encode(text)),
    close: () => body.controller?.close(),
  }
}

// Lets real I/O (the fake response body) reach the fiber before virtual time moves on.
const settle = TestClock.withLive(Effect.sleep("5 millis"))

describe("OpenRouter", () => {
  it.effect("prepares OpenRouter models through the OpenAI-compatible Chat route", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-4o-mini")

      expect(model).toMatchObject({
        id: "openai/gpt-4o-mini",
        provider: "openrouter",
        route: { id: "openrouter" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openrouter")
      expect(prepared.body).toMatchObject({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("applies OpenRouter payload options from the model helper", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({
            apiKey: "test-key",
            providerOptions: {
              openrouter: {
                usage: true,
                reasoning: { effort: "high" },
                promptCacheKey: "session_123",
              },
            },
          }).model("anthropic/claude-3.7-sonnet:thinking"),
          prompt: "Think briefly.",
        }),
      )

      expect(prepared.body).toMatchObject({
        usage: { include: true },
        reasoning: { effort: "high" },
        prompt_cache_key: "session_123",
      })
    }),
  )

  it.effect("streams delta.reasoning as reasoning and accumulates reasoning_details chunks", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "", reasoning: "I need", reasoning_details: [textDetail("I need")] }),
        deltaChunk({ content: "", reasoning: " to check.", reasoning_details: [textDetail(" to check.")] }),
        deltaChunk({
          content: "",
          reasoning_details: [
            { type: "reasoning.text", signature: "sig-abc", format: "anthropic-claude-v1", index: 0 },
          ],
        }),
        deltaChunk({ content: "No." }),
        deltaChunk({ content: "", reasoning: null }, "stop"),
      )

      const response = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Is 391 prime?" })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      expect(response.reasoning).toBe("I need to check.")
      expect(response.text).toBe("No.")
      expect(response.message.content).toEqual([
        { type: "reasoning", text: "I need to check." },
        { type: "text", text: "No." },
        {
          type: "reasoning",
          text: "",
          providerMetadata: {
            openrouter: {
              reasoning_details: [
                {
                  type: "reasoning.text",
                  text: "I need to check.",
                  signature: "sig-abc",
                  format: "anthropic-claude-v1",
                  index: 0,
                },
              ],
            },
          },
        },
      ])
    }),
  )

  it.effect("keeps encrypted-only details on a trailing reasoning block after tool calls close reasoning", () =>
    Effect.gen(function* () {
      const encrypted = {
        type: "reasoning.encrypted",
        data: "opaque==",
        format: "google-gemini-v1",
        id: "call_1",
        index: 0,
      }
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          content: "",
          reasoning: "Weather needs a tool.",
          reasoning_details: [encrypted],
        }),
        deltaChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } }] }),
        deltaChunk({}, "tool_calls"),
      )

      const response = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Weather?", tools })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      expect(response.reasoning).toBe("Weather needs a tool.")
      expect(response.message.content.filter((part) => part.type === "reasoning")).toEqual([
        { type: "reasoning", text: "Weather needs a tool." },
        { type: "reasoning", text: "", providerMetadata: { openrouter: { reasoning_details: [encrypted] } } },
      ])
      expect(response.toolCalls).toMatchObject([{ id: "call_1", name: "get_weather" }])
      expect(response.finishReason).toBe("tool-calls")
    }),
  )

  it.effect("keeps separate detail blocks apart when their index changes", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ reasoning: "a", reasoning_details: [{ type: "reasoning.text", text: "a", index: 0 }] }),
        deltaChunk({ reasoning: "b", reasoning_details: [{ type: "reasoning.text", text: "b", index: 1 }] }),
        deltaChunk({ content: "done" }, "stop"),
      )

      const response = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Hi" })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      expect(response.message.content.at(-1)).toMatchObject({
        providerMetadata: {
          openrouter: {
            reasoning_details: [
              { type: "reasoning.text", text: "a", index: 0 },
              { type: "reasoning.text", text: "b", index: 1 },
            ],
          },
        },
      })
    }),
  )

  it.effect("sends reasoning_details back unmodified on the next assistant tool-call message", () =>
    Effect.gen(function* () {
      const details = [
        { type: "reasoning.text", text: "Call the tool.", signature: "sig", format: "google-gemini-v1", index: 0 },
        { type: "reasoning.encrypted", data: "opaque==", format: "google-gemini-v1", id: "call_1", index: 1 },
      ]
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: gemini,
          tools,
          messages: [
            Message.user("Weather?"),
            Message.assistant([
              { type: "reasoning", text: "Call the tool." },
              { type: "reasoning", text: "", providerMetadata: { openrouter: { reasoning_details: details } } },
              ToolCallPart.make({ id: "call_1", name: "get_weather", input: {} }),
            ]),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "Call the tool.",
            reasoning_details: details,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
          },
        ],
      })
    }),
  )

  it.effect("round-trips streamed reasoning into the next OpenRouter request", () =>
    Effect.gen(function* () {
      const encrypted = { type: "reasoning.encrypted", data: "opaque==", format: "google-gemini-v1", index: 0 }
      const first = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Weather?", tools })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({ reasoning_details: [encrypted] }),
              deltaChunk({
                tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } }],
              }),
              deltaChunk({}, "tool_calls"),
            ),
          ),
        ),
      )
      const prepared = yield* LLMClient.prepare(
        LLM.request({ model: gemini, tools, messages: [Message.user("Weather?"), first.message] }),
      )

      expect(prepared.body).toMatchObject({
        messages: [{ role: "user" }, { role: "assistant", content: null, reasoning_details: [encrypted] }],
      })
    }),
  )

  it.effect("never forwards OpenRouter reasoning_details to another OpenAI Chat route", () =>
    Effect.gen(function* () {
      const reasoning = {
        type: "reasoning" as const,
        text: "thinking",
        providerMetadata: {
          openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque==", index: 0 }] },
        },
      }
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenAICompatible.deepseek.configure({ apiKey: "fixture" }).model("deepseek-chat"),
          messages: [Message.assistant([reasoning, { type: "text", text: "Hello" }])],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [{ role: "assistant", content: "Hello", reasoning_content: "thinking" }],
      })
      expect(JSON.stringify(prepared.body)).not.toContain("reasoning_details")
    }),
  )

  it.effect("omits reasoning_details when history carries none", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({ model: gemini, messages: [Message.assistant([{ type: "reasoning", text: "plain" }])] }),
      )

      expect(JSON.stringify(prepared.body)).not.toContain("reasoning_details")
    }),
  )

  it.effect("fails a stalled stream with a retryable Timeout after the route's idle limit", () =>
    Effect.gen(function* () {
      const server = controlledStream()
      const fiber = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.flip,
        Effect.forkChild,
      )
      yield* settle
      server.write(": OPENROUTER PROCESSING\n\n")
      yield* settle

      yield* TestClock.adjust("119 seconds")
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect("counts SSE keepalive comments as stream activity during long thinking", () =>
    Effect.gen(function* () {
      const server = controlledStream()
      const fiber = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.forkChild,
      )
      yield* settle

      // Ten virtual minutes of silence apart from keepalives, well past the 2 minute idle limit.
      for (const _ of Array.from({ length: 10 })) {
        server.write(": OPENROUTER PROCESSING\n\n")
        yield* settle
        yield* TestClock.adjust("60 seconds")
        yield* settle
        expect(fiber.pollUnsafe()).toBeUndefined()
      }
      server.write(sseEvents(deltaChunk({ content: "Done." }, "stop")))
      server.close()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Done.")
    }),
  )
})
