import { describe, expect, test } from "bun:test"
import { currentTabIndexForClose, currentTabIndexForSessionRemoval, isServerRoute } from "./tab-removal"
import type { ServerConnection } from "./server"
import { tabHref, tabKey, type SessionTab, type Tab } from "./tab"

const local = "local" as ServerConnection.Key
const remote = "remote" as ServerConnection.Key

function sessionTab(server: ServerConnection.Key, sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab removal routes", () => {
  test("uses the route instead of stale recent state when closing the active tab", () => {
    const stale = sessionTab(local, "stale")
    const active = sessionTab(remote, "active")

    expect(
      currentTabIndexForClose({
        tabs: [stale, active],
        navigationKey: undefined,
        currentKey: tabKey(stale),
        pathname: tabHref(active),
        routeDraftID: undefined,
        routeSessionID: active.sessionId,
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(1)
  })

  test("identifies the active draft from its route", () => {
    const stale = sessionTab(local, "stale")
    const active: Tab = { type: "draft", draftID: "active", server: local, directory: "/repo" }

    expect(
      currentTabIndexForClose({
        tabs: [stale, active],
        navigationKey: undefined,
        currentKey: tabKey(stale),
        pathname: "/new-session",
        routeDraftID: active.draftID,
        routeSessionID: undefined,
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(1)
  })

  test("uses pending navigation when it differs from the committed route", () => {
    const committed = sessionTab(local, "committed")
    const pending = sessionTab(remote, "pending")

    expect(
      currentTabIndexForClose({
        tabs: [committed, pending],
        navigationKey: tabKey(pending),
        currentKey: tabKey(pending),
        pathname: "/",
        routeDraftID: undefined,
        routeSessionID: undefined,
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(1)
  })

  test("does not use stale recent state from home", () => {
    const recent = sessionTab(local, "recent")

    expect(
      currentTabIndexForClose({
        tabs: [recent],
        navigationKey: undefined,
        currentKey: tabKey(recent),
        pathname: "/",
        routeDraftID: undefined,
        routeSessionID: undefined,
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(-1)
  })

  test("identifies an explicitly targeted remote session route", () => {
    const current = sessionTab(remote, "session")
    const tabs: Tab[] = [current, { type: "draft", draftID: "draft", server: local, directory: "/repo" }]

    expect(
      currentTabIndexForSessionRemoval({
        tabs,
        targetServer: remote,
        sessionIDs: ["session"],
        currentKey: tabKey(current),
        pathname: tabHref(current),
        routeSessionID: "session",
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(0)
  })

  test("uses the active root tab when a deleted route is a child session", () => {
    const root = sessionTab(remote, "root")
    const child = sessionTab(remote, "child")
    const tabs: Tab[] = [root, { type: "draft", draftID: "draft", server: local, directory: "/repo" }]

    expect(
      currentTabIndexForSessionRemoval({
        tabs,
        targetServer: remote,
        sessionIDs: ["child"],
        currentKey: tabKey(root),
        pathname: tabHref(child),
        routeSessionID: "child",
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(0)
  })

  test("falls back to the removed tab when current tab state has not caught up", () => {
    const current = sessionTab(remote, "session")

    expect(
      currentTabIndexForSessionRemoval({
        tabs: [current],
        targetServer: remote,
        sessionIDs: ["session"],
        currentKey: undefined,
        pathname: tabHref(current),
        routeSessionID: "session",
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(0)
  })

  test("does not remove a session shown through a different server route", () => {
    const current = sessionTab(remote, "session")

    expect(
      currentTabIndexForSessionRemoval({
        tabs: [current],
        targetServer: remote,
        sessionIDs: ["session"],
        currentKey: tabKey(current),
        pathname: tabHref(sessionTab(local, "session")),
        routeSessionID: "session",
        selectedServer: local,
        legacyDirectory: undefined,
      }),
    ).toBe(-1)
  })

  test("recognizes server-owned routes", () => {
    expect(isServerRoute(tabHref(sessionTab(remote, "session")), remote)).toBe(true)
    expect(isServerRoute(tabHref(sessionTab(remote, "session")), local)).toBe(false)
  })
})
