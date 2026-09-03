import { describe, expect, test } from "bun:test"
import { LobbySession } from "../src/lobby-session"
import { Schema } from "effect"

const effect = (profile: LobbySession.CapabilityProfile, action: string) =>
  LobbySession.capabilityRules(profile)
    .filter((rule) => rule.action === "*" || rule.action === action)
    .at(-1)?.effect

describe("LobbySession capability profiles", () => {
  test("defaults old lobby bindings to workspace scope", () => {
    const binding = Schema.decodeUnknownSync(LobbySession.Binding)({
      baseURL: "http://127.0.0.1:8787",
      roomID: "room_1",
      agentMemberID: "agent_1",
    })
    expect(LobbySession.capabilityProfile(binding)).toBe("workspace")
  })

  test("workspace permits local work but denies durable scope expansion", () => {
    expect(effect("workspace", "edit")).toBe("allow")
    expect(effect("workspace", "external_directory")).toBe("deny")
    expect(effect("workspace", "handoff_session")).toBe("deny")
    expect(effect("workspace", "automation_create")).toBe("deny")
    expect(effect("workspace", "memory.write")).toBe("deny")
  })

  test("read-only and full profiles remain explicit", () => {
    expect(effect("read_only", "read")).toBe("allow")
    expect(effect("read_only", "edit")).toBe("deny")
    expect(effect("full", "external_directory")).toBe("allow")
  })
})
