import { describe, expect, test } from "bun:test"
import type { LobbyMember } from "./lobby-client"
import { lobbyConnectionLabel, lobbyConnectionTone, lobbyParticipantPresence, lobbyRoomIsActive } from "./lobby-view"

const localMember: LobbyMember = {
  id: "forge-user",
  type: "human",
  name: "TurenOS user",
  joined_at: "2026-08-20T00:00:00Z",
}
const remoteMember: LobbyMember = {
  id: "research-agent",
  type: "agent",
  name: "Research agent",
  joined_at: "2026-08-20T00:00:00Z",
}

describe("lobby view state", () => {
  test("marks the selected room active without claiming remote members are live", () => {
    expect(lobbyRoomIsActive("room_1", "room_1")).toBe(true)
    expect(lobbyRoomIsActive("room_2", "room_1")).toBe(false)
    expect(lobbyParticipantPresence(localMember, "forge-user")).toBe("you (offline)")
    expect(lobbyParticipantPresence(remoteMember, "forge-user")).toBe("offline")
    expect(
      lobbyParticipantPresence(remoteMember, "forge-user", {
        member_id: remoteMember.id,
        member_type: "agent",
        state: "online",
        typing: true,
        updated_at: "2026-08-20T00:00:00Z",
        expires_at: "2026-08-20T00:00:35Z",
      }),
    ).toBe("typing")
  })

  test("uses explicit local connection labels and state tones", () => {
    expect(lobbyConnectionLabel("not_configured")).toBe("Not configured")
    expect(lobbyConnectionLabel("connected")).toBe("Connected")
    expect(lobbyConnectionLabel("offline")).toBe("Offline/retrying")
    expect(lobbyConnectionLabel("local_error")).toBe("Local-server error")
    expect(lobbyConnectionTone("connected")).toContain("success")
    expect(lobbyConnectionTone("local_error")).toContain("critical")
  })
})
