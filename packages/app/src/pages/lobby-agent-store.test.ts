import { describe, expect, test } from "bun:test"
import {
  emptyLobbyAgentStore,
  lobbyAgentStoreNormalizer,
  lobbyRoomAgentDrafts,
  lobbyRoomAgentMappings,
  removeLobbyRoomAgents,
  removeLobbyAgentMapping,
  migrateLobbyAgentStore,
  setLobbyPendingAgents,
  snapshotLobbyAgentDrafts,
  snapshotLobbyAgentStore,
  upsertLobbyAgentMapping,
} from "./lobby-agent-store"
import type { LobbyAgentMapping } from "./lobby-agent-controller"

const mapping = (instanceID: string): LobbyAgentMapping => ({
  instanceID,
  lobbyBaseURL: "http://127.0.0.1:8787",
  roomID: "room_1",
  agentMemberID: `agent_${instanceID}`,
  agentName: `Agent ${instanceID}`,
  agentHandle: `agent-${instanceID}`,
  sessionID: `ses_${instanceID}`,
  directory: "/repo",
  model: { providerID: "provider", id: `model_${instanceID}` },
  capabilityProfile: "workspace",
  status: "ready",
  lastHandledSequence: 4,
  killGeneration: 0,
  stopRevision: 0,
})

describe("lobby agent store", () => {
  test("migrates one legacy room mapping without changing its identities", () => {
    const legacy = mapping("legacy")
    const migrated = migrateLobbyAgentStore({
      rooms: {
        roomKey: Object.fromEntries(
          Object.entries(legacy).filter(([key]) => key !== "instanceID" && key !== "capabilityProfile"),
        ),
      },
    })

    expect(migrated.version).toBe(2)
    expect(lobbyRoomAgentMappings(migrated, "roomKey")).toEqual([{ ...legacy, instanceID: legacy.agentMemberID }])
  })

  test("normalizes persisted legacy JSON before hydration", () => {
    const legacy = mapping("legacy")
    const normalized = JSON.parse(
      lobbyAgentStoreNormalizer({ rooms: { roomKey: { ...legacy, instanceID: undefined } } }),
    )

    expect(normalized.version).toBe(2)
    expect(normalized.agents.roomKey[legacy.agentMemberID].sessionID).toBe(legacy.sessionID)
  })

  test("backfills a stable public handle for existing roster mappings", () => {
    const legacy = mapping("legacy")
    const migrated = migrateLobbyAgentStore({
      version: 2,
      agents: { roomKey: { legacy: { ...legacy, agentHandle: undefined, agentName: "Luna Ops" } } },
      pending: {},
    })

    expect(lobbyRoomAgentMappings(migrated, "roomKey")[0]?.agentHandle).toBe("luna-ops")
  })

  test("upserts independent agents without overwriting another cursor", () => {
    const first = upsertLobbyAgentMapping(emptyLobbyAgentStore(), "roomKey", mapping("a"))
    const second = upsertLobbyAgentMapping(first, "roomKey", mapping("b"))
    const updated = upsertLobbyAgentMapping(second, "roomKey", { ...mapping("a"), lastHandledSequence: 9 })

    expect(
      lobbyRoomAgentMappings(updated, "roomKey").map((item) => [item.instanceID, item.lastHandledSequence]),
    ).toEqual([
      ["a", 9],
      ["b", 4],
    ])
  })

  test("finds mappings and pending agents across loopback URL aliases", () => {
    const mappingValue = { ...mapping("a"), lobbyBaseURL: "http://localhost:8787" }
    const store = upsertLobbyAgentMapping(emptyLobbyAgentStore(), "http://localhost:8787\0room", mappingValue)
    const withPending = setLobbyPendingAgents(store, "http://localhost:8787\0room", [
      { id: "draft", name: "Agent", model: mappingValue.model },
    ])

    expect(lobbyRoomAgentMappings(withPending, "http://127.0.0.1:8787\0room")).toEqual([mappingValue])
    expect(lobbyRoomAgentDrafts(withPending, "http://127.0.0.1:8787\0room")).toHaveLength(1)
  })

  test("removes every mapping and pending draft for one canonical room", () => {
    const first = upsertLobbyAgentMapping(emptyLobbyAgentStore(), "http://localhost:8787\0room", mapping("a"))
    const second = upsertLobbyAgentMapping(first, "lobby:http%3A%2F%2F127.0.0.1%3A8787:other", mapping("b"))
    const withPending = setLobbyPendingAgents(second, "http://127.0.0.1:8787\0room", [{ id: "draft", name: "Agent" }])
    const removed = removeLobbyRoomAgents(withPending, "lobby:http%3A%2F%2F127.0.0.1%3A8787:room")

    expect(lobbyRoomAgentMappings(removed, "http://localhost:8787\0room")).toEqual([])
    expect(lobbyRoomAgentDrafts(removed, "http://localhost:8787\0room")).toEqual([])
    expect(lobbyRoomAgentMappings(removed, "lobby:http%3A%2F%2F127.0.0.1%3A8787:other")).toHaveLength(1)
  })

  test("removes one agent mapping without affecting room peers", () => {
    const first = upsertLobbyAgentMapping(
      emptyLobbyAgentStore(),
      "lobby:http%3A%2F%2F127.0.0.1%3A8787:room",
      mapping("a"),
    )
    const second = upsertLobbyAgentMapping(first, "lobby:http%3A%2F%2F127.0.0.1%3A8787:room", mapping("b"))
    const removed = removeLobbyAgentMapping(second, "http://localhost:8787\0room", "a")

    expect(lobbyRoomAgentMappings(removed, "http://127.0.0.1:8787\0room").map((item) => item.instanceID)).toEqual(["b"])
  })

  test("stores optional pending wizard agents and clears them", () => {
    const draft = { id: "draft_1", name: "Responder", model: { providerID: "provider", id: "model" } }
    const pending = setLobbyPendingAgents(emptyLobbyAgentStore(), "roomKey", [draft])
    const cleared = setLobbyPendingAgents(pending, "roomKey", undefined)

    expect(pending.pending.roomKey).toEqual([draft])
    expect(cleared.pending.roomKey).toBeUndefined()
  })

  test("snapshots Solid store proxies before persistence or network work", () => {
    const wizard = new Proxy(
      [
        {
          id: "draft_1",
          name: "Responder",
          capabilityProfile: "workspace" as const,
          model: { providerID: "provider", id: "model", variant: "fast" },
        },
      ],
      {},
    )
    const store = new Proxy(upsertLobbyAgentMapping(emptyLobbyAgentStore(), "roomKey", mapping("a")), {})

    expect(() => structuredClone(wizard)).toThrow()
    expect(() => structuredClone(store)).toThrow()
    expect(snapshotLobbyAgentDrafts(wizard)).toEqual([
      {
        id: "draft_1",
        name: "Responder",
        capabilityProfile: "workspace",
        model: { providerID: "provider", id: "model", variant: "fast" },
      },
    ])
    expect(lobbyRoomAgentMappings(snapshotLobbyAgentStore(store), "roomKey")).toEqual([mapping("a")])
  })
})
