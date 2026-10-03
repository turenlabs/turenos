import { describe, expect, test } from "bun:test"
import { LLM } from "@turenlabs/llm"
import { OpenRouter, XAI } from "@turenlabs/llm/providers"
import { Effect } from "effect"
import { CacheAffinity } from "@turenlabs/core/session/runner/cache-affinity"

const key = "a".repeat(64)
const parent = "ses_" + "b".repeat(64)
const generic = { "x-session-affinity": key, "x-session-id": key }

// Providers the opencode fork can reach. Each row is [providerID, baseURL].
const withGenericHeaders: ReadonlyArray<readonly [string, string]> = [
  ["openai", "https://api.openai.com/v1"],
  ["anthropic", "https://api.anthropic.com/v1"],
  ["google", "https://generativelanguage.googleapis.com/v1beta"],
  ["google-vertex", "https://us-central1-aiplatform.googleapis.com"],
  ["amazon-bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com"],
  ["azure", "https://example.openai.azure.com/openai"],
  ["openrouter", "https://openrouter.ai/api/v1"],
  ["xai", "https://api.x.ai/v1"],
  ["fireworks-ai", "https://api.fireworks.ai/inference/v1"],
  ["togetherai", "https://api.together.xyz/v1"],
  ["deepinfra", "https://api.deepinfra.com/v1/openai"],
  ["groq", "https://api.groq.com/openai/v1"],
  ["cerebras", "https://api.cerebras.ai/v1"],
  ["mistral", "https://api.mistral.ai/v1"],
  ["moonshotai", "https://api.moonshot.ai/v1"],
  ["venice", "https://api.venice.ai/api/v1"],
  ["kilo", "https://api.kilo.ai/api/gateway"],
  ["zenmux", "https://zenmux.ai/api/v1"],
  ["vercel", "https://ai-gateway.vercel.sh/v1"],
  ["github-copilot", "https://api.githubcopilot.com"],
  ["gitlab", "https://gitlab.com/api/v4/ai"],
  ["ollama", "http://localhost:11434/v1"],
  ["llama-cpp", "http://localhost:8080/v1"],
]

describe("CacheAffinity.headers", () => {
  test.each(withGenericHeaders)("%s gets the session affinity pair", (providerID, baseURL) => {
    const sent = CacheAffinity.headers({ providerID, baseURL, key })
    expect(sent).toMatchObject(generic)
    expect(sent?.["x-parent-session-id"]).toBeUndefined()
  })

  test.each(["opencode", "opencode-go", "opencode-zen"])(
    "%s sends none: its route already carries x-opencode-session",
    (providerID) => {
      expect(CacheAffinity.headers({ providerID, baseURL: "https://opencode.ai/zen/v1", key })).toBeUndefined()
    },
  )

  test("only xAI gets its conversation header", () => {
    expect(CacheAffinity.headers({ providerID: "xai", baseURL: "https://api.x.ai/v1", key })).toMatchObject({
      ...generic,
      "x-grok-conv-id": key,
    })
    for (const [providerID, baseURL] of withGenericHeaders.filter(([id]) => id !== "xai"))
      expect(CacheAffinity.headers({ providerID, baseURL, key })).not.toHaveProperty("x-grok-conv-id")
    // A lookalike host never receives it.
    expect(
      CacheAffinity.headers({ providerID: "custom", baseURL: "https://api.x.ai.evil.example/v1", key }),
    ).not.toHaveProperty("x-grok-conv-id")
  })

  test("a subagent also names its parent", () => {
    expect(
      CacheAffinity.headers({
        providerID: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        key,
        parentSessionID: parent,
      }),
    ).toMatchObject({ ...generic, "x-parent-session-id": parent })
  })

  test("tolerates unusable base URLs and refuses an empty key", () => {
    expect(CacheAffinity.headers({ providerID: "openai", baseURL: undefined, key })).toMatchObject(generic)
    expect(CacheAffinity.headers({ providerID: "openai", baseURL: "not a url", key })).toMatchObject(generic)
    expect(
      CacheAffinity.headers({ providerID: "openai", baseURL: () => "https://api.x.ai/v1", key }),
    ).not.toHaveProperty("x-grok-conv-id")
    expect(CacheAffinity.headers({ providerID: "openai", baseURL: "https://api.openai.com/v1", key: "" })).toBeUndefined()
  })
})

describe("cache affinity through real routes", () => {
  const options = { openai: { promptCacheKey: key }, openrouter: { promptCacheKey: key } }
  const prepare = (model: ReturnType<typeof OpenRouter.model>, providerID: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const request = LLM.request({
          model,
          prompt: "Hello",
          providerOptions: options,
          http: { headers: CacheAffinity.headers({ providerID, baseURL: model.route.endpoint.baseURL, key }) },
        })
        const body = yield* model.route.body.from(request)
        const prepared = yield* model.route.prepareTransport(body, request)
        return { body: body as Record<string, unknown>, headers: prepared.request.headers as Record<string, string> }
      }),
    )

  test("OpenRouter carries the sticky-routing header and the body key", async () => {
    const sent = await prepare(OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-5"), "openrouter")
    expect(sent.headers["x-session-id"]).toBe(key)
    expect(sent.headers["x-session-affinity"]).toBe(key)
    expect(sent.body.prompt_cache_key).toBe(key)
  })

  test("xAI carries the conversation header", async () => {
    const model = XAI.configure({ apiKey: "test-key" }).model("grok-4")
    const sent = await prepare(model as ReturnType<typeof OpenRouter.model>, "xai")
    expect(sent.headers["x-grok-conv-id"]).toBe(key)
    expect(sent.headers["x-session-affinity"]).toBe(key)
  })

  test("an opencode-go request adds none of our headers", async () => {
    const sent = await prepare(OpenRouter.configure({ apiKey: "test-key" }).model("kimi-k2"), "opencode-go")
    for (const name of ["x-session-affinity", "x-session-id", "x-grok-conv-id", "x-parent-session-id"])
      expect(sent.headers[name]).toBeUndefined()
  })
})
