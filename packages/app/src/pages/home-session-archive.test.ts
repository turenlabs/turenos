import { expect, test } from "bun:test"
import type { Session } from "@turenlabs/sdk/v2/client"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { applyHomeSessionEvent } from "@/context/global-sync/home-session-index"
import { archivedHomeSessionEvent, archiveHomeSession } from "./home-session-archive"
import type { ServerConnection } from "@/context/server"

const remote = "remote" as ServerConnection.Key

test("archiving a Home session removes its open titlebar tab", async () => {
  let detail: ReturnType<typeof readSessionTabsRemovedDetail>
  let removed = false
  window.addEventListener(
    SESSION_TABS_REMOVED_EVENT,
    (event) => {
      detail = readSessionTabsRemovedDetail(event)
    },
    { once: true },
  )

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    update: async () => undefined,
    remove: () => {
      removed = true
    },
  })

  expect(removed).toBe(true)
  expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
})

test("reports archive failures without removing the session", async () => {
  const failure = new Error("offline")
  let error: unknown
  let removed = false

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    update: async () => Promise.reject(failure),
    remove: () => {
      removed = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(removed).toBe(false)
})

test("passes the archive update to remove so optimistic caches share its timestamp", async () => {
  const updates: unknown[] = []
  let received: { directory: string; sessionID: string; time: { archived: number } } | undefined

  await archiveHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    update: async (value) => {
      updates.push(value)
    },
    remove: (update) => {
      received = update
    },
  })

  expect(received).toEqual({ directory: "/workspace", sessionID: "ses_1", time: { archived: expect.any(Number) } })
  expect(updates).toEqual([received])
})

test("archivedHomeSessionEvent removes the session from the home index", () => {
  const session: Session = {
    id: "ses_1",
    slug: "ses_1",
    projectID: "project",
    directory: "/workspace",
    title: "Session",
    version: "dev",
    time: { created: 1, updated: 1 },
  }
  const other: Session = { ...session, id: "ses_2", slug: "ses_2" }

  const event = archivedHomeSessionEvent(session, 42)

  expect(event).toEqual({
    type: "session.updated",
    properties: { sessionID: "ses_1", info: { ...session, time: { created: 1, updated: 1, archived: 42 } } },
  })
  expect(applyHomeSessionEvent([session, other], event)).toEqual([other])
})
