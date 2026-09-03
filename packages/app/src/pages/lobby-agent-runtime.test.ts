import { describe, expect, test } from "bun:test"
import type { ForgeClient, SessionDurableEvent, SessionMessage } from "@turenlabs/sdk/v2/client"
import { createLobbyAgentSessionRuntime } from "./lobby-agent-runtime"

const model = { providerID: "provider", id: "model" }
const binding = {
  lobbyBaseURL: "http://127.0.0.1:8787",
  roomID: "room_1",
  agentMemberID: "forge-agent-1",
  capabilityProfile: "workspace" as const,
}

describe("lobby SessionV2 runtime", () => {
  test("creates one selected-model lobby session", async () => {
    const fixture = runtimeFixture({ getError: { status: 404 } })
    await fixture.runtime.ensure({
      sessionID: "ses_lobby_1",
      directory: "/repo",
      model,
      ...binding,
      signal: new AbortController().signal,
    })

    expect(fixture.created).toEqual([
      {
        id: "ses_lobby_1",
        agent: "lobby",
        model,
        metadata: {
          "forge.internal": true,
          "forge.origin": "lobby",
          "forge.lobby": {
            baseURL: binding.lobbyBaseURL,
            roomID: binding.roomID,
            agentMemberID: binding.agentMemberID,
            capabilityProfile: binding.capabilityProfile,
          },
        },
        location: { directory: "/repo" },
      },
    ])
  })

  test("backfills the internal marker when adopting an existing lobby session", async () => {
    const fixture = runtimeFixture({ metadata: {} })
    await fixture.runtime.ensure({
      sessionID: "ses_lobby_1",
      directory: "/repo",
      model,
      ...binding,
      signal: new AbortController().signal,
    })

    expect(fixture.updated).toEqual([
      {
        sessionID: "ses_lobby_1",
        metadata: {
          "forge.internal": true,
          "forge.origin": "lobby",
          "forge.lobby": {
            baseURL: binding.lobbyBaseURL,
            roomID: binding.roomID,
            agentMemberID: binding.agentMemberID,
            capabilityProfile: binding.capabilityProfile,
          },
        },
      },
    ])
  })

  test("prompts once, waits for the matching completed assistant, and exposes text only", async () => {
    const fixture = runtimeFixture({
      events: [
        event("session.next.prompt.admitted", 2, { messageID: "msg_lobby_1" }),
        event("session.next.step.started", 3, { assistantMessageID: "msg_assistant_1" }),
        event("session.next.step.ended", 4, { assistantMessageID: "msg_assistant_1", finish: "stop" }),
      ],
      message: assistant("public response"),
    })
    const text = await fixture.runtime.respond({
      sessionID: "ses_lobby_1",
      directory: "/repo",
      promptID: "msg_lobby_1",
      prompt: "untrusted room message",
      model,
      signal: new AbortController().signal,
    })

    expect(text).toBe("public response")
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0]).toMatchObject({ delivery: "queue", agent: "lobby", model })
  })

  test("exact retry wakes the same prompt after its latest failed event", async () => {
    const fixture = runtimeFixture({
      history: [
        event("session.next.prompt.admitted", 2, { messageID: "msg_lobby_1" }),
        event("session.next.step.started", 3, { assistantMessageID: "msg_failed" }),
        event("session.next.step.failed", 4, {
          assistantMessageID: "msg_failed",
          error: { type: "unknown", message: "failed" },
        }),
      ],
      events: [
        event("session.next.step.started", 5, { assistantMessageID: "msg_assistant_1" }),
        event("session.next.step.ended", 6, { assistantMessageID: "msg_assistant_1", finish: "stop" }),
      ],
      message: assistant("retry response"),
    })

    expect(
      await fixture.runtime.respond({
        sessionID: "ses_lobby_1",
        directory: "/repo",
        promptID: "msg_lobby_1",
        prompt: "same prompt",
        model,
        signal: new AbortController().signal,
      }),
    ).toBe("retry response")
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0]).toMatchObject({ id: "msg_lobby_1" })
  })

  test("adopts a completed exact retry without another prompt", async () => {
    const fixture = runtimeFixture({
      history: [
        event("session.next.prompt.admitted", 2, { messageID: "msg_lobby_1" }),
        event("session.next.step.started", 3, { assistantMessageID: "msg_assistant_1" }),
        event("session.next.step.ended", 4, { assistantMessageID: "msg_assistant_1", finish: "stop" }),
      ],
      message: assistant("already complete"),
    })
    expect(
      await fixture.runtime.respond({
        sessionID: "ses_lobby_1",
        directory: "/repo",
        promptID: "msg_lobby_1",
        prompt: "same prompt",
        model,
        signal: new AbortController().signal,
      }),
    ).toBe("already complete")
    expect(fixture.prompts).toHaveLength(0)
  })
})

function runtimeFixture(
  options: {
    getError?: unknown
    events?: SessionDurableEvent[]
    history?: SessionDurableEvent[]
    message?: SessionMessage
    metadata?: Record<string, unknown>
  } = {},
) {
  const created: unknown[] = []
  const updated: unknown[] = []
  const prompts: unknown[] = []
  const session = {
    get: async () => {
      if (options.getError) throw options.getError
      return {
        data: {
          data: {
            id: "ses_lobby_1",
            agent: "lobby",
            model,
            metadata: options.metadata,
            location: { directory: "/repo" },
          },
        },
      }
    },
    create: async (input: unknown) => {
      created.push(input)
      return { data: { data: input } }
    },
    switchAgent: async () => ({}),
    switchModel: async () => ({}),
    history: async () => ({ data: { data: options.history ?? [], hasMore: false, latest: -1 } }),
    prompt: async (input: unknown) => {
      prompts.push(input)
      return {}
    },
    events: async () => ({
      stream: (async function* () {
        for (const value of options.events ?? []) yield value
      })(),
    }),
    message: async () => ({ data: { data: options.message } }),
    interrupt: async () => ({}),
  }
  const client = {
    session: {
      update: async (input: unknown) => {
        updated.push(input)
        return {}
      },
    },
    v2: { session },
  } as unknown as ForgeClient
  return { runtime: createLobbyAgentSessionRuntime({ client: () => client }), created, updated, prompts }
}

function event(type: SessionDurableEvent["type"], sequence: number, data: Record<string, unknown>) {
  return {
    id: `event_${sequence}`,
    type,
    durable: { aggregateID: "ses_lobby_1", seq: sequence, version: 1 },
    data: { sessionID: "ses_lobby_1", timestamp: sequence, ...data },
  } as SessionDurableEvent
}

function assistant(text: string): SessionMessage {
  return {
    id: "msg_assistant_1",
    type: "assistant",
    agent: "lobby",
    model,
    time: { created: 1, completed: 2 },
    content: [
      { id: "reasoning", type: "reasoning", text: "private" },
      { id: "text", type: "text", text },
    ],
  }
}
