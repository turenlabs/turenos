import { base64Encode } from "@turenlabs/core/util/encode"
import type { ServerConnection } from "./server"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

export function migrateTabs(value: unknown, fallback: ServerConnection.Key) {
  if (!Array.isArray(value)) return value

  return value.flatMap((tab) => {
    if (!tab || typeof tab !== "object") return [tab]
    const record = tab as Record<string, unknown>
    if (record.type === "terminal") return []
    return ["server" in record ? record : { ...record, server: fallback }]
  })
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) => {
  if (tab.type === "draft") return draftHref(tab.draftID)
  return `/server/${base64Encode(tab.server)}/session/${tab.sessionId}`
}

export const tabKey = (tab: Tab) => {
  if (tab.type === "draft") return `draft:${tab.draftID}`
  return `${tab.server}\n${tabHref(tab)}`
}

export function promoteDraftTab(tabs: Tab[], draftID: string, session: SessionTab) {
  const matchesSession = (tab: Tab) =>
    tab.type === "session" && tab.server === session.server && tab.sessionId === session.sessionId
  const existing = tabs.find(matchesSession)

  if (existing) {
    const hasDraft = tabs.some((tab) => tab.type === "draft" && tab.draftID === draftID)
    let placed = false
    return tabs.flatMap((tab) => {
      if (tab.type === "draft" && tab.draftID === draftID) {
        if (placed) return []
        placed = true
        return [existing]
      }
      if (!matchesSession(tab)) return [tab]
      if (hasDraft || placed) return []
      placed = true
      return [existing]
    })
  }

  let replaced = false
  const next = tabs.flatMap((tab) => {
    if (tab.type !== "draft" || tab.draftID !== draftID) return [tab]
    if (replaced) return []
    replaced = true
    return [session]
  })
  if (!replaced) next.push(session)
  return next
}
