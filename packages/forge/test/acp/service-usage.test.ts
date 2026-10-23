import { describe, expect } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { ForgeClient } from "@turenlabs/sdk/v2"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { make } from "@/acp/service"
import { Directory } from "@/acp/directory"
import { UsageService } from "@/acp/usage"
import { TestInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

const providerID = ProviderV2.ID.make("usage-provider")
const modelID = ModelV2.ID.make("usage-model")

// The default usage service reads the context limit from the real provider
// list of the session's directory, so the temp instance configures the model.
const config = {
  model: `${providerID}/${modelID}`,
  provider: {
    [providerID]: {
      name: "Usage Provider",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: { [modelID]: { name: "Usage Model", tool_call: true, limit: { context: 64_000, output: 4096 } } },
      options: { apiKey: "test-key" },
    },
  },
}

const assistant = {
  role: "assistant",
  providerID,
  modelID,
  cost: 0.25,
  tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 20, write: 0 } },
}

// Stands in for the HTTP client to the Forge server. Without `usage`, the usage
// service under test is the default one ACPService builds.
function setup(usage?: UsageService.Interface) {
  const updates: SessionNotification[] = []
  const created = { count: 0 }
  const sdk = {
    session: {
      create: () => {
        created.count++
        return Promise.resolve({ data: { id: `ses_usage_${created.count}` } })
      },
      prompt: () => Promise.resolve({ data: { info: assistant } }),
      messages: () => Promise.resolve({ data: [{ info: assistant, parts: [] }] }),
    },
  } as unknown as ForgeClient
  const connection = {
    sessionUpdate: (update: SessionNotification) => {
      updates.push(update)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const snapshot = Directory.build({
    directory: "/workspace",
    providers: {},
    modes: [],
    defaultModeID: "build",
    commands: [],
    defaultModel: { providerID, modelID },
  })
  const service = make({
    sdk,
    connection,
    usage,
    directory: {
      get: () => Effect.succeed(snapshot),
      refresh: () => Effect.succeed(snapshot),
      variants: Directory.variants,
    },
  })
  return { service, updates }
}

function usageUpdates(updates: readonly SessionNotification[]) {
  return updates.filter((item) => item.update.sessionUpdate === "usage_update")
}

function usageUpdate(sessionId: string) {
  return {
    sessionId,
    update: {
      sessionUpdate: "usage_update",
      used: 120,
      size: 64_000,
      cost: { amount: 0.25, currency: "USD" },
    },
  } satisfies SessionNotification
}

describe("ACP service default usage", () => {
  it.instance(
    "prompt succeeds and sends a usage update without an injected usage service",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const acp = setup()
        const session = yield* acp.service.newSession({ cwd: test.directory, mcpServers: [] })

        const result = yield* acp.service.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        })

        expect(result.stopReason).toBe("end_turn")
        expect(usageUpdates(acp.updates)).toEqual([usageUpdate(session.sessionId)])
      }),
    { config },
  )

  it.instance(
    "concurrent and repeated prompts each send a usage update",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const acp = setup()
        const first = yield* acp.service.newSession({ cwd: test.directory, mcpServers: [] })
        const second = yield* acp.service.newSession({ cwd: test.directory, mcpServers: [] })
        const prompt = (sessionId: string) =>
          acp.service.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })

        const concurrent = yield* Effect.all([prompt(first.sessionId), prompt(second.sessionId)], {
          concurrency: "unbounded",
        })
        const later = yield* prompt(first.sessionId)

        expect([...concurrent, later].map((item) => item.stopReason)).toEqual(["end_turn", "end_turn", "end_turn"])
        expect(usageUpdates(acp.updates).toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
          usageUpdate(first.sessionId),
          usageUpdate(first.sessionId),
          usageUpdate(second.sessionId),
        ])
      }),
    { config },
  )
})

describe("ACP service usage failure", () => {
  it.effect("a failing usage update is logged and does not fail the prompt", () =>
    Effect.gen(function* () {
      // Every call dies, as a usage runtime whose cached layer build failed would.
      const failure = () => Effect.die(new Error("usage runtime failed to build"))
      const acp = setup(
        UsageService.Service.of({
          buildUsage: UsageService.buildUsage,
          latestAssistantMessage: UsageService.latestAssistantMessage,
          totalSessionCost: UsageService.totalSessionCost,
          contextLimit: failure,
          sendUpdate: failure,
        }),
      )
      const session = yield* acp.service.newSession({ cwd: "/workspace", mcpServers: [] })
      const prompt = acp.service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })

      const first = yield* prompt
      const second = yield* prompt

      expect([first.stopReason, second.stopReason]).toEqual(["end_turn", "end_turn"])
      expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 40, cachedReadTokens: 20, totalTokens: 160 })
      expect(usageUpdates(acp.updates)).toEqual([])
      expect((yield* TestConsole.logLines).filter((line) => line === "ACP usage update failed")).toHaveLength(2)
    }),
  )
})
