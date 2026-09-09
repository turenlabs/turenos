import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { LLMRequestPrep } from "@/session/llm/request"

const sessionID = "ses_opencode_headers"

const model = (providerID: string) =>
  ({
    id: `${providerID}/deepseek-v4-flash`,
    providerID,
    api: {
      id: "deepseek-v4-flash",
      url: "https://opencode.ai/zen/go/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "DeepSeek V4 Flash",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
  }) as any

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const prepareHeaders = (providerID: string) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: "msg_opencode_headers",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID, modelID: "deepseek-v4-flash" },
      } as any,
      sessionID,
      model: model(providerID),
      agent: { name: "test", mode: "primary", prompt: "test", options: {}, permission: [] } as any,
      system: [],
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      provider: { id: providerID, options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  ).then((result) => result.headers)

describe("OpenCode request headers", () => {
  test("identifies OpenCode Go and carries the conversation session", async () => {
    const first = await prepareHeaders("opencode-go")
    const second = await prepareHeaders("opencode-go")

    expect(first["User-Agent"]).toBe(`TurenOS/${InstallationVersion}`)
    expect(first["x-opencode-session"]).toBe(sessionID)
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"])
    expect(first["x-session-affinity"]).toBeUndefined()
    expect(first["X-Session-Id"]).toBeUndefined()
  })

  test("does not leak OpenCode headers to other providers", async () => {
    const headers = await prepareHeaders("other-provider")

    expect(headers["User-Agent"]).toBe(`TurenOS/${InstallationVersion}`)
    expect(headers["x-session-affinity"]).toBe(sessionID)
    expect(headers["X-Session-Id"]).toBe(sessionID)
    expect(headers["x-opencode-session"]).toBeUndefined()
  })
})
