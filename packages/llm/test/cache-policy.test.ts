import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message, ToolCallPart } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AmazonBedrock } from "../src/providers"
import { AnthropicMessages } from "../src/protocols/anthropic-messages"
import { Gemini } from "../src/protocols/gemini"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { applyCachePolicy } from "../src/cache-policy"
import { it } from "./lib/effect"

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const bedrockModel = AmazonBedrock.configure({
  credentials: { region: "us-east-1", accessKeyId: "fixture", secretAccessKey: "fixture" },
}).model("anthropic.claude-3-5-sonnet-20241022-v2:0")

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const geminiModel = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-2.5-flash" })

describe("applyCachePolicy", () => {
  it.effect("undefined cache resolves to 'auto' (the recommended default)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "You are concise.",
          prompt: "hi",
        }),
      )

      // No explicit cache field → auto policy fires → last system part + latest
      // user message both get cache_control markers.
      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      })
    }),
  )

  it.effect("'auto' marks the last tool, last system part, and latest user message on Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys A",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [
            Message.user("first user"),
            Message.assistant("assistant reply"),
            Message.user("latest user message"),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys A", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "first user" }] },
          { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
          {
            role: "user",
            content: [{ type: "text", text: "latest user message", cache_control: { type: "ephemeral" } }],
          },
        ],
      })
    }),
  )

  // Goal-continuation reminders embed token/time counters that change every
  // request. Marking one wrote a breakpoint that was never read and left the
  // whole transcript prefix uncached — re-billed at full input rate per turn.
  const internalContext = (content: string) =>
    Message.make({ role: "user", content, metadata: { forge: { internalContext: "goal" } } })
  const preparedMessages = (messages: ReadonlyArray<Message>) =>
    LLMClient.prepare(LLM.request({ model: anthropicModel, system: "Sys", messages, cache: "auto" })).pipe(
      Effect.map((prepared) => (prepared.body as { messages: unknown }).messages),
    )

  it.effect("auto advances through tool results while keeping the stable user boundary", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("Inspect the repository"),
        ...Array.from({ length: 24 }, (_, index) => [
          Message.assistant([ToolCallPart.make({ id: `call_${index}`, name: "read", input: { index } })]),
          Message.tool({ id: `call_${index}`, name: "read", result: `file contents ${index}` }),
        ]).flat(),
        internalContext("goal: 123 tokens remaining"),
      ]
      const request = LLM.request({
        model: anthropicModel,
        system: "Sys",
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
        messages,
      })
      const prepared = yield* LLMClient.prepare(request)
      const body = prepared.body as {
        messages: Array<{ content: Array<{ cache_control?: unknown; type: string }> }>
      }
      expect(body.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages.at(-2)?.content[0]).toMatchObject({
        type: "tool_result",
        cache_control: { type: "ephemeral" },
      })
      expect(body.messages.at(-1)?.content[0]?.cache_control).toBeUndefined()
      expect(JSON.stringify(prepared.body).match(/"cache_control"/g)?.length).toBe(4)
      expect(JSON.stringify(request)).not.toContain('"cache":')
      const next = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          messages: [...messages.slice(0, -1), internalContext("goal: 99 tokens remaining")],
        }),
      )
      expect((next.body as typeof body).messages.slice(0, -1)).toEqual(body.messages.slice(0, -1))

      const bedrock = yield* LLMClient.prepare(LLM.updateRequest(request, { model: bedrockModel }))
      expect(bedrock.body).toMatchObject({
        messages: expect.arrayContaining([
          { role: "user", content: [{ toolResult: expect.anything() }, { cachePoint: { type: "default" } }] },
        ]),
      })
    }),
  )

  it.effect("auto caches trailing image content instead of stopping at preceding text", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user([
          { type: "text", text: "Inspect this image" },
          { type: "media", mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
        ]),
      ]
      const prepared = yield* LLMClient.prepare(LLM.request({ model: anthropicModel, messages }))
      expect(prepared.body).toMatchObject({
        messages: [
          {
            content: [
              { type: "text", cache_control: undefined },
              { type: "image", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
      })
      const bedrock = yield* LLMClient.prepare(LLM.request({ model: bedrockModel, messages }))
      expect(bedrock.body).toMatchObject({
        messages: [
          {
            content: [
              { text: "Inspect this image" },
              { image: expect.anything() },
              { cachePoint: { type: "default" } },
            ],
          },
        ],
      })
    }),
  )

  test("auto skips reasoning-only tails and granular user caching stays user-only", () => {
    const messages = [
      Message.user("Start"),
      Message.tool({ id: "call", name: "read", result: "contents" }),
      Message.assistant([{ type: "reasoning", text: "thinking", encrypted: "signature" }]),
    ]
    const request = LLM.request({ model: anthropicModel, messages })
    const cached = applyCachePolicy(request)
    expect(cached.messages[1]?.content[0]).toHaveProperty("cache")
    expect(cached.messages[2]?.content[0]).not.toHaveProperty("cache")
    const explicit = applyCachePolicy(LLM.updateRequest(request, { cache: { messages: "latest-user-message" } }))
    expect(explicit.messages[0]?.content[0]).toHaveProperty("cache")
    expect(explicit.messages[1]?.content[0]).not.toHaveProperty("cache", expect.anything())
  })

  it.effect("'auto' skips per-turn internal-context user messages when placing the breakpoint", () =>
    Effect.gen(function* () {
      const messages = yield* preparedMessages([
        Message.user("durable user message"),
        Message.assistant("assistant reply"),
        internalContext("goal continuation: 12345 tokens used"),
      ])

      expect(messages).toMatchObject([
        {
          role: "user",
          content: [{ type: "text", text: "durable user message", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
        {
          role: "user",
          content: [{ type: "text", text: "goal continuation: 12345 tokens used", cache_control: undefined }],
        },
      ])
    }),
  )

  it.effect("falls back to the internal-context message when no durable user message exists", () =>
    Effect.gen(function* () {
      const messages = yield* preparedMessages([internalContext("goal continuation only")])

      expect(messages).toMatchObject([
        {
          role: "user",
          content: [{ type: "text", text: "goal continuation only", cache_control: { type: "ephemeral" } }],
        },
      ])
    }),
  )

  it.effect("'auto' is a no-op on OpenAI (implicit caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { messages: Array<{ content: unknown }> }
      // OpenAI doesn't accept cache_control on messages — policy must skip.
      const flat = JSON.stringify(body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' is a no-op on Gemini (out-of-band caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: geminiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const flat = JSON.stringify(prepared.body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' on Bedrock emits cachePoint markers in the right places", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("first user"), Message.assistant("reply"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "t1" } }, { cachePoint: { type: "default" } }],
        },
        system: [{ text: "Sys" }, { cachePoint: { type: "default" } }],
        messages: [
          { role: "user", content: [{ text: "first user" }] },
          { role: "assistant", content: [{ text: "reply" }] },
          { role: "user", content: [{ text: "latest user" }, { cachePoint: { type: "default" } }] },
        ],
      })
    }),
  )

  it.effect("'none' disables auto placement even when manual hints exist", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: undefined }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("granular object form: tools-only marks just tools", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: { tools: true },
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("auto policy preserves manual CacheHints on other parts", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            { type: "text", text: "first system", cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }) },
            { type: "text", text: "last system" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { system: Array<{ text: string; cache_control?: unknown }> }
      expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("ttlSeconds in the policy flows through to wire markers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          prompt: "hi",
          cache: { system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      })
    }),
  )

  it.effect("messages: { tail: 2 } marks the last 2 message boundaries", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2"), Message.assistant("a2")],
          cache: { messages: { tail: 2 } },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[2]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages[3]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
    }),
  )

  it.effect("'latest-assistant' marks the last assistant message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2")],
          cache: { messages: "latest-assistant" },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral" })
      expect(body.messages[2]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  test("returns the same request reference when policy is a no-op (pure function)", () => {
    const request = LLM.request({
      model: anthropicModel,
      prompt: "hi",
      cache: "none",
    })
    expect(applyCachePolicy(request)).toBe(request)
  })
})
