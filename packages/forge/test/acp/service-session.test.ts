import { describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  ForkSessionResponse,
  LoadSessionResponse,
  NewSessionResponse,
  SessionNotification,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk"
import type { AssistantMessage, ForgeClient } from "@turenlabs/sdk/v2"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import * as ACPError from "@/acp/error"
import { Directory } from "@/acp/directory"
import { UsageService } from "@/acp/usage"
import type { Provider } from "@/provider/provider"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const configuredModelID = ModelV2.ID.make("configured-model")
const secondModelID = ModelV2.ID.make("second-model")

const provider: Provider.Info = {
  id: providerID,
  name: "Test",
  source: "api",
  env: [],
  options: {},
  models: {
    [modelID]: {
      id: modelID,
      providerID,
      api: {
        id: modelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Test Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        default: {},
        high: { reasoningEffort: "high" },
      },
    },
    [configuredModelID]: {
      id: configuredModelID,
      providerID,
      api: {
        id: configuredModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Configured Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
    [secondModelID]: {
      id: secondModelID,
      providerID,
      api: {
        id: secondModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Second Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
      },
    },
  },
}

function directoryService(input: {
  readonly defaultModel?: Directory.DefaultModel
  readonly commands?: Directory.Snapshot["availableCommands"]
}) {
  const snapshot = Directory.build({
    directory: "/workspace",
    providers: { [providerID]: provider },
    modes: [
      { id: "build", name: "build" },
      { id: "plan", name: "plan", description: "Plan first" },
    ],
    defaultModeID: "build",
    commands: input.commands ?? [
      { name: "init", description: "Initialize", source: "command", template: "init", hints: [] },
      { name: "review-skill", description: "Review", source: "skill", template: "review", hints: [] },
    ],
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
  })
  return {
    get: (_directory: string) => Effect.succeed(snapshot),
    refresh: () => Effect.succeed(snapshot),
    variants: Directory.variants,
  } satisfies Directory.Interface
}

function countedDirectoryService(calls: { directory: number }, input: Parameters<typeof directoryService>[0] = {}) {
  const service = directoryService(input)
  return {
    ...service,
    get: (directory: string) => {
      calls.directory++
      return service.get(directory)
    },
  } satisfies Directory.Interface
}

describe("ACP service sessions", () => {
  const makeService = (
    messages: readonly { info: unknown; parts: readonly unknown[] }[] = [],
    options?: {
      abort?: (input: { sessionID: string }) => Promise<{ data: boolean }>
      prompt?: (input: unknown) => Promise<{ data: { info: ReturnType<typeof assistantInfo> } }>
    },
  ) => {
    const updates: SessionNotification[] = []
    const aborts: string[] = []
    const forks: string[] = []
    const prompts: unknown[] = []
    const commands: unknown[] = []
    const summarizes: unknown[] = []
    const usageUpdates: string[] = []
    const sessions = Array.from({ length: 102 }, (_, index) => ({
      id: `ses_${index + 1}`,
      directory: index % 2 === 0 ? "/workspace" : "/other",
      title: `Session ${index + 1}`,
      time: { created: index + 1, updated: index + 1 },
    }))
    const sdk = {
      session: {
        create: () => Promise.resolve({ data: { id: "ses_new" } }),
        get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
        list: (input: { directory?: string }) =>
          Promise.resolve({
            data: input.directory ? sessions.filter((session) => session.directory === input.directory) : sessions,
          }),
        messages: () => Promise.resolve({ data: messages }),
        prompt:
          options?.prompt ??
          ((input: unknown) => {
            prompts.push(input)
            return Promise.resolve({
              data: {
                info: assistantInfo({
                  input: 100,
                  output: 40,
                  reasoning: 7,
                  cache: { read: 11, write: 13 },
                }),
              },
            })
          }),
        command: (input: unknown) => {
          commands.push(input)
          return Promise.resolve({
            data: {
              info: assistantInfo({
                input: 3,
                output: 4,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              }),
            },
          })
        },
        summarize: (input: unknown) => {
          summarizes.push(input)
          return Promise.resolve({ data: true })
        },
        abort:
          options?.abort ??
          ((input: { sessionID: string }) => {
            aborts.push(input.sessionID)
            return Promise.resolve({ data: true })
          }),
        fork: (input: { sessionID: string }) => {
          forks.push(input.sessionID)
          return Promise.resolve({ data: { id: `fork_${input.sessionID}` } })
        },
      },
    } as unknown as ForgeClient
    const connection = {
      sessionUpdate: (update: SessionNotification) => {
        updates.push(update)
        return Promise.resolve()
      },
    } as Pick<AgentSideConnection, "sessionUpdate">
    const usage = UsageService.Service.of({
      buildUsage: UsageService.buildUsage,
      latestAssistantMessage: UsageService.latestAssistantMessage,
      totalSessionCost: UsageService.totalSessionCost,
      contextLimit: () => Effect.succeed(128000),
      sendUpdate: (input) =>
        Effect.sync(() => {
          usageUpdates.push(input.sessionID)
        }),
    })

    return {
      service: ACPService.make({
        sdk,
        connection,
        usage,
        directory: directoryService({ defaultModel: { providerID, modelID } }),
      }),
      updates,
      aborts,
      forks,
      prompts,
      commands,
      summarizes,
      usageUpdates,
    }
  }

  it("creates a backed session with config options and command update", async () => {
    const { service, updates } = makeService()
    const result = await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [],
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(result.sessionId).toBe("ses_new")
    expect(categories(result)).toContain("model")
    expect(categories(result)).toContain("thought_level")
    expect(categories(result)).toContain("mode")
    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates[0])).toContain("available_commands_update")
    expect(JSON.stringify(updates[0])).toContain("review-skill")
  })

  it("loads a session and restores model variant and mode from messages", async () => {
    const { service } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          variant: "high",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("replays loaded session transcript chunks", async () => {
    const { service, updates } = makeService([
      {
        info: { id: "msg_user", sessionID: "ses_loaded", role: "user" },
        parts: [{ id: "part_user", sessionID: "ses_loaded", messageID: "msg_user", type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_loaded", role: "assistant" },
        parts: [
          {
            id: "part_assistant",
            sessionID: "ses_loaded",
            messageID: "msg_assistant",
            type: "text",
            text: "hi there",
          },
        ],
      },
    ])

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(
      updates
        .map((item) => item.update)
        .filter((item) => item.sessionUpdate === "user_message_chunk" || item.sessionUpdate === "agent_message_chunk"),
    ).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "msg_user",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_assistant",
        content: { type: "text", text: "hi there" },
      },
    ])
  })

  it("lists sessions sorted by updated time with cursor support", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))
    const second = await Effect.runPromise(service.listSessions({ cwd: "/workspace", cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(51)
    expect(first.sessions[0]?.sessionId).toBe("ses_101")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_1")
    expect(first.nextCursor).toBeUndefined()
    expect(second.sessions).toEqual(first.sessions)
  })

  it("includes live ACP sessions before they appear in server-backed session list", async () => {
    const { service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const listed = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))

    expect(listed.sessions[0]?.sessionId).toBe(created.sessionId)
    expect(listed.sessions[0]?.cwd).toBe("/workspace")
  })

  it("lists all sessions with next cursor when the first page is full", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({}))
    const second = await Effect.runPromise(service.listSessions({ cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(100)
    expect(first.sessions[0]?.sessionId).toBe("ses_102")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_3")
    expect(first.nextCursor).toBe("3")
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["ses_2", "ses_1"])
  })

  it("resumes a session and stores restored state without replaying transcript chunks", async () => {
    const { service, updates } = makeService([
      {
        info: {
          id: "msg_user",
          sessionID: "ses_resume",
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [{ id: "part_user", sessionID: "ses_resume", messageID: "msg_user", type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_resume", role: "assistant" },
        parts: [
          {
            id: "part_assistant",
            sessionID: "ses_resume",
            messageID: "msg_assistant",
            type: "text",
            text: "hi there",
          },
        ],
      },
    ])
    const resumed = await Effect.runPromise(
      service.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: "ses_resume", configId: "effort", value: "default" }),
    )

    expect(select(resumed, "effort")?.currentValue).toBe("high")
    expect(select(updated, "effort")?.currentValue).toBe("default")
    expect(
      updates
        .map((item) => item.update)
        .filter((item) => item.sessionUpdate === "user_message_chunk" || item.sessionUpdate === "agent_message_chunk"),
    ).toEqual([])
  })

  it("closes local ACP state and aborts the backing session best-effort", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    const missing = await Effect.runPromise(
      service
        .setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )
    expect(missing.code).toBe(-32602)
    expect(aborts).toEqual([created.sessionId])
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("cancel aborts the backing session and keeps the ACP session", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))

    // The running turn was aborted via the core session API.
    expect(aborts).toEqual([created.sessionId])
    // Unlike closeSession, the ACP session is still present afterwards so
    // the client can keep prompting.
    const stillUsable = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" }),
    )
    expect(stillUsable).toBeDefined()
  })

  it("does not fail cancel or close when the backing abort fails", async () => {
    const { service } = makeService([], { abort: () => Promise.reject(new Error("nope")) })
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))
    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("forks a session, loads fork state, and returns config options", async () => {
    const { service, forks } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "second-model",
          variant: "medium",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const forked = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: forked.sessionId, configId: "effort", value: "low" }),
    )

    expect(forked.sessionId).toBe("fork_ses_parent")
    expect(select(forked, "model")?.currentValue).toBe("test/second-model")
    expect(select(forked, "effort")?.currentValue).toBe("medium")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(forks).toEqual(["ses_parent"])
  })

  it("restores model variant and mode from the latest user message", async () => {
    const { service } = makeService([
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "default" },
          agent: "build",
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("uses the configured model as the new session default", async () => {
    const sdk = {
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => Promise.resolve({ data: [] }),
      },
    } as unknown as ForgeClient
    const service = ACPService.make({
      sdk,
      directory: directoryService({ defaultModel: { providerID, modelID: configuredModelID } }),
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("configured-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/configured-model")
  })

  it("does not scan last-used sessions when resolving the new session default", async () => {
    const historyCalls: string[] = []
    const sdk = {
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => {
          historyCalls.push("list")
          return Promise.resolve({ data: [{ id: "ses_recent" }] })
        },
        messages: () => {
          historyCalls.push("messages")
          return Promise.resolve({
            data: [{ info: { role: "user", model: { providerID: "test", modelID: "second-model" } } }],
          })
        },
      },
    } as unknown as ForgeClient
    const service = ACPService.make({
      sdk,
      directory: directoryService({ defaultModel: { providerID, modelID } }),
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("test-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/test-model")
    expect(historyCalls).toEqual([])
  })

  it("switches model and returns updated model and effort options", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(flattenSelectOptions(select(updated, "effort")).map((option) => option.value)).toEqual(["low", "medium"])
  })

  it("switches effort and returns the updated effort current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(select(updated, "effort")?.currentValue).toBe("high")
  })

  it("switches mode and returns the updated mode current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    expect(select(updated, "mode")?.currentValue).toBe("plan")
  })

  it("maps invalid model effort mode and config id to invalid params", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const results = await Promise.all(
      [
        { configId: "model", value: "test/missing-model" },
        { configId: "effort", value: "max" },
        { configId: "mode", value: "missing-mode" },
        { configId: "missing", value: "value" },
      ].map((input) =>
        Effect.runPromise(
          service
            .setSessionConfigOption({ sessionId: session.sessionId, ...input })
            .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
        ),
      ),
    )
    expect(results.map((error) => error.code)).toEqual([-32602, -32602, -32602, -32602])
  })

  it("does not refetch the directory snapshot when switching effort", async () => {
    const calls = { directory: 0 }
    const sdk = {
      session: {
        create: () => Promise.resolve({ data: { id: "ses_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
    } as unknown as ForgeClient
    const service = ACPService.make({ sdk, directory: countedDirectoryService(calls) })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(calls).toEqual({ directory: 1 })

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(calls).toEqual({ directory: 1 })
  })

  it("switches model against the warm directory snapshot without refetching", async () => {
    const calls = { directory: 0 }
    const sdk = {
      session: {
        create: () => Promise.resolve({ data: { id: "ses_model_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
    } as unknown as ForgeClient
    const service = ACPService.make({ sdk, directory: countedDirectoryService(calls) })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(calls).toEqual({ directory: 1 })
  })

  it("loads the directory snapshot for each new session in the same cwd", async () => {
    const calls = { directory: 0, sessionList: 0, messages: 0, creates: 0 }
    const sdk = {
      session: {
        create: () => {
          calls.creates++
          return Promise.resolve({ data: { id: `ses_warm_${calls.creates}` } })
        },
        list: () => {
          calls.sessionList++
          return Promise.resolve({ data: [] })
        },
        messages: () => {
          calls.messages++
          return Promise.resolve({ data: [] })
        },
      },
    } as unknown as ForgeClient
    const service = ACPService.make({ sdk, directory: countedDirectoryService(calls) })

    const first = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const second = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(first.sessionId).toBe("ses_warm_1")
    expect(second.sessionId).toBe("ses_warm_2")
    expect(calls).toEqual({
      directory: 2,
      sessionList: 0,
      messages: 0,
      creates: 2,
    })
  })

  it("normal text prompt sends model variant mode and converted parts", async () => {
    const { service, prompts, usageUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    const result = await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        messageId: "00000000-0000-4000-8000-000000000001",
        prompt: [{ type: "text", text: "hello" }],
      }),
    )

    expect(prompts).toEqual([
      {
        sessionID: session.sessionId,
        model: { providerID, modelID },
        variant: "high",
        parts: [{ type: "text", text: "hello" }],
        agent: "plan",
        directory: "/workspace",
      },
    ])
    expect(result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        thoughtTokens: 7,
        cachedReadTokens: 11,
        cachedWriteTokens: 13,
        totalTokens: 171,
      },
      userMessageId: "00000000-0000-4000-8000-000000000001",
      _meta: {},
    })
    expect(usageUpdates).toEqual([session.sessionId])
  })

  it("maps assistant prompt errors to request errors instead of end turn", async () => {
    const { service } = makeService([], {
      prompt: () =>
        Promise.resolve({
          data: {
            info: assistantInfo(
              { input: 8, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              { name: "APIError", data: { message: "Provider request failed", isRetryable: false } },
            ),
          },
        }),
    })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const error = await Effect.runPromise(
      service
        .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32603)
    expect(error.message).toBe("Internal error: Provider request failed")
    expect(error.data).toEqual({ service: "session", errorName: "APIError" })
  })

  it("maps aborted assistant prompt errors to cancelled", async () => {
    const { service } = makeService([], {
      prompt: () =>
        Promise.resolve({
          data: {
            info: assistantInfo(
              { input: 8, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              { name: "MessageAbortedError", data: { message: "Aborted" } },
            ),
          },
        }),
    })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const result = await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
    )

    expect(result.stopReason).toBe("cancelled")
  })

  it("prompt maps assistant and user audience annotations", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "assistant context", annotations: { audience: ["assistant"] } },
          { type: "text", text: "user context", annotations: { audience: ["user"] } },
        ],
      }),
    )

    expect(prompts).toContainEqual({
      sessionID: session.sessionId,
      model: { providerID, modelID },
      variant: "default",
      parts: [
        { type: "text", text: "assistant context", synthetic: true },
        { type: "text", text: "user context", ignored: true },
      ],
      agent: "build",
      directory: "/workspace",
    })
  })

  it("prompt sends image and resource parts", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///tmp/screenshot.png" },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/report.pdf",
              mimeType: "application/pdf",
              blob: "JVBERg==",
            },
          },
        ],
      }),
    )

    expect((prompts[0] as { parts?: unknown }).parts).toEqual([
      {
        type: "file",
        url: "data:image/png;base64,AAAA",
        filename: "screenshot.png",
        mime: "image/png",
      },
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERg==",
        filename: "report.pdf",
        mime: "application/pdf",
      },
    ])
  })

  it("slash command prompt calls session command", async () => {
    const { service, prompts, commands } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const result = await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/init now" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([
      {
        sessionID: session.sessionId,
        command: "init",
        arguments: "now",
        model: "test/test-model",
        variant: "default",
        agent: "build",
        directory: "/workspace",
      },
    ])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  })

  it("compact slash command calls summarize path", async () => {
    const { service, prompts, commands, summarizes } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/compact" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([])
    expect(summarizes).toEqual([
      {
        sessionID: session.sessionId,
        directory: "/workspace",
        providerID,
        modelID,
      },
    ])
  })
})

function assistantInfo(
  tokens: UsageService.AssistantTokenCost["tokens"],
  error?: AssistantMessage["error"],
): UsageService.AssistantMessage & Pick<AssistantMessage, "error"> {
  return {
    role: "assistant",
    providerID: "test",
    modelID: "test-model",
    cost: 0,
    tokens,
    ...(error ? { error } : {}),
  }
}

function categories(result: NewSessionResponse | LoadSessionResponse) {
  return result.configOptions?.map((option) => option.category) ?? []
}

function select(
  result: SetSessionConfigOptionResponse | ResumeSessionResponse | NewSessionResponse | ForkSessionResponse,
  id: string,
) {
  return result.configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.id === id && option.type === "select",
  )
}

function flattenSelectOptions(option: Extract<SessionConfigOption, { type: "select" }> | undefined) {
  return option?.options.flatMap((item): SessionConfigSelectOption[] => ("value" in item ? [item] : item.options)) ?? []
}
