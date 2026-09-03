import { describe, expect, test } from "bun:test"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ClaudeCodeProvider } from "../../src/provider/claude-code"

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}

function fakeProcess(stdout: string, code = 0) {
  return {
    exited: Promise.resolve(code),
    stdout: stream(stdout),
    stderr: stream(""),
    kill() {},
  }
}

describe("ClaudeCodeProvider", () => {
  test("catalog models are local and have zero API cost", () => {
    const provider = ClaudeCodeProvider.info()
    expect(String(provider.id)).toBe("claude-code")
    expect(Object.keys(provider.models)).toEqual(["fable", "sonnet", "opus", "haiku"])
    for (const model of Object.values(provider.models)) {
      expect(model.api.url).toBe("local://claude-code")
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
    }
    expect(provider.models.fable.api.id).toBe("claude-fable-5")
    expect(provider.models.fable.limit).toEqual({ context: 1_000_000, output: 128_000 })
  })

  /**
   * The context panel divides by the number this snapshot publishes, so a stale
   * value here shows up directly as a wrong percentage -- and, since the v2
   * runner reads the same `ClaudeCodeCLI.MODELS` table, as a wrong compaction
   * threshold too.
   *
   * Entries transcribed from the real catalog (`https://models.dev/api.json`).
   * Both Opus generations are live under one family and only `release_date`
   * separates them; `claude-opus-4-5` is still 200k, which is exactly the number
   * this provider used to hardcode for `opus`.
   */
  test("resolves each CLI alias's window from the catalog it proxies", () => {
    const catalog = {
      anthropic: {
        models: {
          "claude-opus-5": {
            family: "claude-opus",
            release_date: "2026-07-24",
            limit: { context: 1_000_000, output: 128_000 },
          },
          "claude-opus-4-5": {
            family: "claude-opus",
            release_date: "2025-11-24",
            limit: { context: 200_000, output: 64_000 },
          },
          "claude-sonnet-5": {
            family: "claude-sonnet",
            release_date: "2026-06-29",
            limit: { context: 1_000_000, output: 128_000 },
          },
          "claude-haiku-4-5": {
            family: "claude-haiku",
            release_date: "2025-10-15",
            limit: { context: 200_000, output: 64_000 },
          },
        },
      },
    } as never

    const provider = ClaudeCodeProvider.info(catalog)

    // The regression: `opus` is Opus 5, a 1M model, reported as 200k.
    expect(provider.models.opus.limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(provider.models.sonnet.limit).toEqual({ context: 1_000_000, output: 128_000 })
    // Haiku really is 200k -- the fix must not just raise everything.
    expect(provider.models.haiku.limit).toEqual({ context: 200_000, output: 64_000 })
  })

  test("falls back to the static table when no catalog is available", () => {
    // A packaged build with no snapshot must still publish a usable window.
    const provider = ClaudeCodeProvider.info()
    const fallback = ClaudeCodeCLI.MODELS.find((item) => item.id === "opus")!
    expect(provider.models.opus.limit.context).toBe(fallback.context)
    expect(provider.models.opus.limit.context).toBeGreaterThan(0)
  })

  // The composer renders its effort selector off this snapshot while the turn is
  // resolved against the v2 catalog, so the ids have to be identical on both
  // sides — otherwise the UI offers a level that quietly falls back to default.
  test("publishes the same per-model effort variants as the v2 catalog", () => {
    const provider = ClaudeCodeProvider.info()
    for (const item of ClaudeCodeCLI.MODELS) {
      expect(Object.keys(provider.models[item.id]!.variants ?? {})).toEqual([...item.efforts])
    }
    expect(Object.keys(provider.models.opus.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(Object.keys(provider.models.fable.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
    // Haiku 4.5 has no effort capability, so the selector must stay hidden for it.
    expect(Object.keys(provider.models.haiku.variants ?? {})).toEqual([])
  })

  test("removes API and proxy credentials from the child environment", () => {
    const original = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    }
    process.env.ANTHROPIC_API_KEY = "secret-api-key"
    process.env.ANTHROPIC_AUTH_TOKEN = "secret-token"
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid"
    try {
      const env = ClaudeCodeProvider.subscriptionEnvironment({
        SAFE: "kept",
        ANTHROPIC_API_KEY: "api-key",
        ANTHROPIC_MODEL: "claude-opus-5",
        CLAUDE_CODE_API_BASE_URL: "https://proxy.example",
        CLAUDE_CODE_OAUTH_TOKEN: "alternate-token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        NO_PROXY: "internal.example",
      })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
      expect(env.ANTHROPIC_MODEL).toBeUndefined()
      expect(env.CLAUDE_CODE_API_BASE_URL).toBeUndefined()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(env.SAFE).toBe("kept")
      expect(env.NO_PROXY).toContain("127.0.0.1")
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("forge")
    } finally {
      if (original.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original.apiKey
      if (original.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = original.token
      if (original.baseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = original.baseURL
    }
  })

  test("detects an authenticated Claude subscription without retaining account details", async () => {
    const result = await ClaudeCodeProvider.probe(
      "claude",
      () => fakeProcess('{"loggedIn":true,"authMethod":"claude.ai","email":"secret@example.com"}'),
      () => "/usr/local/bin/claude",
    )
    expect(result).toEqual({ status: "authenticated", executable: "/usr/local/bin/claude" })
    expect(JSON.stringify(result)).not.toContain("secret@example.com")
  })

  test("does not connect missing or logged-out executables", async () => {
    expect(
      await ClaudeCodeProvider.probe(
        "claude",
        () => fakeProcess(""),
        () => null,
      ),
    ).toEqual({
      status: "unavailable",
    })
    expect(
      await ClaudeCodeProvider.probe(
        "claude",
        () => fakeProcess('{"loggedIn":false}'),
        () => "/bin/claude",
      ),
    ).toEqual({ status: "unauthenticated", executable: "/bin/claude" })
  })

  test("fails closed on malformed auth output", async () => {
    expect(
      await ClaudeCodeProvider.probe(
        "claude",
        () => fakeProcess("not-json"),
        () => "/bin/claude",
      ),
    ).toEqual({ status: "unavailable" })
  })
})
