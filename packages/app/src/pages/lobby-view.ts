import type { LobbyMember, LobbyPresence } from "./lobby-client"
import type { LobbyConnection } from "./lobby-directory-controller"

export function lobbyConnectionLabel(connection: LobbyConnection) {
  if (connection === "connecting") return "Connecting"
  if (connection === "connected") return "Connected"
  if (connection === "offline") return "Offline/retrying"
  if (connection === "local_error") return "Local-server error"
  return "Not configured"
}

export function lobbyConnectionTone(connection: LobbyConnection) {
  if (connection === "connected") return "bg-v2-state-bg-success text-v2-state-fg-success"
  if (connection === "connecting") return "bg-v2-state-bg-warning text-v2-state-fg-warning"
  if (connection === "offline" || connection === "local_error")
    return "bg-v2-state-bg-critical text-v2-state-fg-critical"
  return "bg-v2-background-bg-layer-03 text-v2-text-text-muted"
}

export function lobbyParticipantPresence(member: LobbyMember, actorID: string, presence?: LobbyPresence) {
  if (presence?.typing) return member.id === actorID ? "you (typing)" : "typing"
  if (member.id === actorID) return presence ? `you (${presence.state})` : "you (offline)"
  return presence?.state ?? "offline"
}

export function lobbyRoomIsActive(roomID: string, selectedID: string | undefined) {
  return roomID === selectedID
}
