import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { AgentV2 } from "@turenlabs/core/agent"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Project } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionStore } from "@turenlabs/core/session/store"
import { LobbyRoomContextTool } from "@turenlabs/core/tool/lobby-room-context"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_lobby_context_tool")
const directory = AbsolutePath.make("/tmp/forge-lobby-context-tool")
let metadata: Record<string, unknown> = {
  [LobbySession.MetadataKey]: {
    baseURL: "http://127.0.0.1:8787",
    roomID: "room_test",
    agentMemberID: "forge-agent-test",
  },
}
let roomName = "Incident room"
const requests: string[] = []

const session = () =>
  SessionV2.Info.make({
    id: sessionID,
    projectID: Project.ID.make("lobby-context-tool"),
    title: "Lobby context",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory },
    metadata,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })
const store = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(session()),
  context: () => Effect.die("unused"),
  runnerContext: () => Effect.die("unused"),
  message: () => Effect.die("unused"),
})
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    requests.push(request.url)
    const url = new URL(request.url)
    const body = url.pathname.endsWith("/messages")
      ? {
          data: [
            {
              id: "evt_1",
              room_id: "room_test",
              sequence: 3,
              actor_id: "human_1",
              actor_type: "human",
              text: "Investigate",
              created_at: "2026-08-27T00:00:00Z",
            },
          ],
          next_after: 3,
          has_more: false,
        }
      : {
          id: "room_test",
          name: roomName,
          created_at: "2026-08-27T00:00:00Z",
          head: 3,
          members: [
            { id: "human_1", type: "human", name: "Analyst", joined_at: "2026-08-27T00:00:00Z" },
            { id: "forge-agent-test", type: "agent", name: "@atlas", joined_at: "2026-08-27T00:00:01Z" },
          ],
        }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))))
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, SessionToolProvider.node, LobbyRoomContextTool.node]), [
    [SessionStore.node, store],
    [LayerNodePlatform.httpClient, http],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const materialize = Effect.gen(function* () {
  const providers = yield* SessionToolProvider.Service
  const registry = yield* ToolRegistry.Service
  const tools = yield* providers.forExecution({
    sessionID,
    directory,
    agent: AgentV2.ID.make("lobby"),
    model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("anthropic"), id: ModelV2.ID.make("claude") }),
  })
  return yield* registry.materialize({ session: tools })
})

describe("LobbyRoomContextTool", () => {
  it.effect("is visible only to bound lobby sessions and queries fresh public state", () =>
    Effect.gen(function* () {
      requests.length = 0
      roomName = "Incident room"
      const first = yield* materialize
      expect(first.definitions.map((definition) => definition.name)).toContain(LobbyRoomContextTool.name)
      const result = yield* first.settle({
        sessionID,
        ...toolIdentity,
        agent: AgentV2.ID.make("lobby"),
        call: { type: "tool-call", id: "call_lobby_context", name: LobbyRoomContextTool.name, input: { limit: 2 } },
      })
      expect(result.output?.structured).toMatchObject({
        room: { name: "Incident room" },
        messages: [{ text: "Investigate" }],
      })
      expect(JSON.stringify(result.result)).not.toContain("forge.lobby")
      expect(requests).toEqual([
        "http://127.0.0.1:8787/rooms/room_test",
        "http://127.0.0.1:8787/rooms/room_test/messages?after=0&limit=100",
      ])

      roomName = "Renamed room"
      const second = yield* materialize
      const refreshed = yield* second.settle({
        sessionID,
        ...toolIdentity,
        agent: AgentV2.ID.make("lobby"),
        call: { type: "tool-call", id: "call_lobby_context_2", name: LobbyRoomContextTool.name, input: {} },
      })
      expect(refreshed.output?.structured).toMatchObject({ room: { name: "Renamed room" } })

      metadata = {}
      const unrelated = yield* materialize
      expect(unrelated.definitions.map((definition) => definition.name)).not.toContain(LobbyRoomContextTool.name)
    }),
  )
})
