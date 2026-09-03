import { base64Encode } from "@turenlabs/core/util/encode"
import type { ServerConnection } from "./server"
import { tabHref, tabKey, type Tab } from "./tab"

export function isServerRoute(pathname: string, server: ServerConnection.Key) {
  return pathname.startsWith(`/server/${base64Encode(server)}/`)
}

export function currentTabIndexForClose(input: {
  tabs: Tab[]
  navigationKey: string | undefined
  currentKey: string | undefined
  pathname: string
  routeDraftID: string | undefined
  routeSessionID: string | undefined
  selectedServer: ServerConnection.Key
  legacyDirectory: string | undefined
}) {
  const navigationIndex = input.tabs.findIndex((tab) => tabKey(tab) === input.navigationKey)
  if (navigationIndex !== -1) return navigationIndex

  const routeIndex = input.tabs.findIndex((tab) => {
    if (tab.type === "draft") {
      return input.pathname === "/new-session" && tab.draftID === input.routeDraftID
    }
    return tabHref(tab) === input.pathname
  })
  if (routeIndex !== -1) return routeIndex

  if (input.routeSessionID && input.legacyDirectory) {
    const legacyIndex = input.tabs.findIndex(
      (tab) =>
        tab.type === "session" && tab.server === input.selectedServer && tab.sessionId === input.routeSessionID,
    )
    if (legacyIndex !== -1) return legacyIndex
  }

  const onTabRoute = input.pathname === "/new-session" || input.pathname.includes("/session/")
  if (!onTabRoute) return -1
  return input.tabs.findIndex((tab) => tabKey(tab) === input.currentKey)
}

export function currentTabIndexForSessionRemoval(input: {
  tabs: Tab[]
  targetServer: ServerConnection.Key
  sessionIDs: string[]
  currentKey: string | undefined
  pathname: string
  routeSessionID: string | undefined
  selectedServer: ServerConnection.Key
  legacyDirectory: string | undefined
}) {
  if (!input.routeSessionID || !input.sessionIDs.includes(input.routeSessionID)) return -1

  const route = { type: "session" as const, server: input.targetServer, sessionId: input.routeSessionID }
  const isCurrentRoute =
    tabHref(route) === input.pathname || (input.targetServer === input.selectedServer && !!input.legacyDirectory)
  if (!isCurrentRoute) return -1

  const currentIndex = input.tabs.findIndex((tab) => tabKey(tab) === input.currentKey)
  const current = input.tabs[currentIndex]
  if (current?.type === "session" && current.server === input.targetServer) return currentIndex

  return input.tabs.findIndex(
    (tab) => tab.type === "session" && tab.server === input.targetServer && tab.sessionId === input.routeSessionID,
  )
}
