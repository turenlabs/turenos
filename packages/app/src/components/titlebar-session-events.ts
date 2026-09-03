import type { ServerConnection } from "@/context/server"

export const SESSION_TABS_REMOVED_EVENT = "forge:session-tabs-removed"

export type SessionTabsRemovedDetail = {
  server: ServerConnection.Key
  directory: string
  sessionIDs: string[]
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("server" in detail) || typeof detail.server !== "string") return undefined
  if (!("directory" in detail)) return undefined
  if (!("sessionIDs" in detail)) return undefined
  if (typeof detail.directory !== "string") return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined

  return {
    server: detail.server as ServerConnection.Key,
    directory: detail.directory,
    sessionIDs,
  }
}

export function sessionTabsRemovedForServerEvent(input: {
  server: ServerConnection.Key
  directory: string
  event: { type: string; properties?: unknown }
}): SessionTabsRemovedDetail | undefined {
  if (input.event.type !== "session.deleted" && input.event.type !== "session.updated") return
  if (!isRecord(input.event.properties) || !isRecord(input.event.properties.info)) return

  const session = input.event.properties.info
  if (typeof session.id !== "string") return
  if (input.event.type === "session.updated" && (!isRecord(session.time) || typeof session.time.archived !== "number"))
    return

  return { server: input.server, directory: input.directory, sessionIDs: [session.id] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
