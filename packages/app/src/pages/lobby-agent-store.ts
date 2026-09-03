import {
  lobbyAgentHandle,
  lobbyAgentStorageKey,
  type LobbyAgentMapping,
  type LobbyAgentModel,
} from "./lobby-agent-controller"

export type LobbyAgentDraft = {
  id: string
  name: string
  agentHandle?: string
  model?: LobbyAgentModel
  capabilityProfile?: LobbyAgentMapping["capabilityProfile"]
}

export type LobbyAgentStore = {
  version: 2
  agents: Record<string, Record<string, LobbyAgentMapping> | undefined>
  pending: Record<string, LobbyAgentDraft[] | undefined>
}

export const emptyLobbyAgentStore = (): LobbyAgentStore => ({ version: 2, agents: {}, pending: {} })

export function migrateLobbyAgentStore(value: unknown): LobbyAgentStore {
  if (!isRecord(value)) return emptyLobbyAgentStore()
  if (value.version === 2 && isRecord(value.agents)) {
    return {
      version: 2,
      agents: Object.fromEntries(
        Object.entries(value.agents).map(([roomKey, room]) => [
          roomKey,
          isRecord(room)
            ? Object.fromEntries(
                Object.entries(room).flatMap(([instanceID, candidate]) =>
                  isLobbyAgentMapping(candidate)
                    ? [
                        [
                          instanceID,
                          {
                            ...candidate,
                            instanceID,
                            agentHandle: lobbyAgentHandleValue(candidate),
                            stopRevision: candidate.stopRevision ?? 0,
                            capabilityProfile: candidate.capabilityProfile ?? "workspace",
                          },
                        ],
                      ]
                    : [],
                ),
              )
            : undefined,
        ]),
      ),
      pending: isRecord(value.pending) ? (value.pending as LobbyAgentStore["pending"]) : {},
    }
  }

  const rooms = isRecord(value.rooms) ? value.rooms : {}
  const agents = Object.fromEntries(
    Object.entries(rooms).flatMap(([roomKey, candidate]) => {
      if (!isLobbyAgentMapping(candidate)) return []
      const instanceID = typeof candidate.instanceID === "string" ? candidate.instanceID : candidate.agentMemberID
      return [
        [
          roomKey,
          {
            [instanceID]: {
              ...candidate,
              instanceID,
              agentHandle: lobbyAgentHandleValue(candidate),
              stopRevision: candidate.stopRevision ?? 0,
              capabilityProfile: candidate.capabilityProfile ?? "workspace",
            },
          },
        ],
      ]
    }),
  )
  return {
    version: 2,
    agents,
    pending: {},
  }
}

function lobbyAgentHandleValue(mapping: LobbyAgentMapping & { agentHandle?: string }) {
  return mapping.agentHandle || lobbyAgentHandle(mapping.agentName)
}

export function lobbyAgentStoreNormalizer(value: unknown) {
  return JSON.stringify(migrateLobbyAgentStore(value))
}

export function snapshotLobbyAgentStore(value: unknown) {
  return migrateLobbyAgentStore(JSON.parse(lobbyAgentStoreNormalizer(value)))
}

export function snapshotLobbyAgentDrafts(drafts: readonly LobbyAgentDraft[]) {
  return drafts.map((draft) => ({
    id: draft.id,
    name: draft.name,
    ...(draft.agentHandle ? { agentHandle: draft.agentHandle } : {}),
    ...(draft.capabilityProfile ? { capabilityProfile: draft.capabilityProfile } : {}),
    ...(draft.model
      ? {
          model: {
            providerID: draft.model.providerID,
            id: draft.model.id,
            ...(draft.model.variant ? { variant: draft.model.variant } : {}),
          },
        }
      : {}),
  }))
}

export function lobbyRoomAgentMappings(store: LobbyAgentStore, roomKey: string) {
  return matchingRoomValues(store.agents, roomKey)
    .flatMap((room) => Object.values(room ?? {}))
    .toSorted((left, right) => left.instanceID.localeCompare(right.instanceID))
}

export function lobbyRoomAgentDrafts(store: LobbyAgentStore, roomKey: string) {
  return matchingRoomValues(store.pending, roomKey).find((drafts) => drafts?.length) ?? []
}

export function upsertLobbyAgentMapping(store: LobbyAgentStore, roomKey: string, mapping: LobbyAgentMapping) {
  return {
    ...store,
    agents: {
      ...store.agents,
      [roomKey]: { ...store.agents[roomKey], [mapping.instanceID]: mapping },
    },
  }
}

export function setLobbyPendingAgents(store: LobbyAgentStore, roomKey: string, drafts: LobbyAgentDraft[] | undefined) {
  return {
    ...store,
    pending: { ...store.pending, [roomKey]: drafts?.length ? drafts : undefined },
  }
}

export function removeLobbyRoomAgents(store: LobbyAgentStore, roomKey: string) {
  const agents = Object.fromEntries(Object.entries(store.agents).filter(([key]) => !sameLobbyRoomKey(key, roomKey)))
  const pending = Object.fromEntries(Object.entries(store.pending).filter(([key]) => !sameLobbyRoomKey(key, roomKey)))
  return { ...store, agents, pending }
}

export function removeLobbyAgentMapping(store: LobbyAgentStore, roomKey: string, instanceID: string) {
  return {
    ...store,
    agents: Object.fromEntries(
      Object.entries(store.agents).map(([key, room]) => {
        if (!sameLobbyRoomKey(key, roomKey) || !room) return [key, room]
        const next = { ...room }
        delete next[instanceID]
        return [key, Object.keys(next).length ? next : undefined]
      }),
    ),
  }
}

function isLobbyAgentMapping(value: unknown): value is LobbyAgentMapping & {
  instanceID?: string
  stopRevision?: number
  capabilityProfile?: LobbyAgentMapping["capabilityProfile"]
} {
  return (
    isRecord(value) &&
    typeof value.lobbyBaseURL === "string" &&
    typeof value.roomID === "string" &&
    typeof value.agentMemberID === "string" &&
    typeof value.sessionID === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matchingRoomValues<T>(rooms: Record<string, T | undefined>, roomKey: string) {
  const requested = parseLobbyRoomKey(roomKey)
  if (!requested) return [rooms[roomKey]]
  return Object.entries(rooms)
    .filter(([key]) => {
      const candidate = parseLobbyRoomKey(key)
      return (
        candidate !== undefined &&
        lobbyAgentStorageKey(candidate.baseURL, candidate.roomID) ===
          lobbyAgentStorageKey(requested.baseURL, requested.roomID)
      )
    })
    .map(([, value]) => value)
}

function sameLobbyRoomKey(left: string, right: string) {
  const leftRoom = parseLobbyRoomKey(left)
  const rightRoom = parseLobbyRoomKey(right)
  if (!leftRoom || !rightRoom) return left === right
  return (
    lobbyAgentStorageKey(leftRoom.baseURL, leftRoom.roomID) ===
    lobbyAgentStorageKey(rightRoom.baseURL, rightRoom.roomID)
  )
}

function parseLobbyRoomKey(value: string) {
  const legacySeparator = value.indexOf("\0")
  if (legacySeparator >= 0)
    return { baseURL: value.slice(0, legacySeparator), roomID: value.slice(legacySeparator + 1) }
  if (!value.startsWith("lobby:")) return
  const separator = value.indexOf(":", "lobby:".length)
  if (separator < 0) return
  try {
    return {
      baseURL: decodeURIComponent(value.slice("lobby:".length, separator)),
      roomID: decodeURIComponent(value.slice(separator + 1)),
    }
  } catch {
    return
  }
}
