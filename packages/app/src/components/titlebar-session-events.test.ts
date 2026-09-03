import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  readSessionTabsRemovedDetail,
  sessionTabsRemovedForServerEvent,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: ["ses_1"] },
        }),
      ),
    ).toBeUndefined()
  })

  test("creates tab cleanup details for deleted and archived server events", () => {
    expect(
      sessionTabsRemovedForServerEvent({
        server: remote,
        directory: "/tmp/project",
        event: { type: "session.deleted", properties: { info: { id: "ses_1" } } },
      }),
    ).toEqual({ server: remote, directory: "/tmp/project", sessionIDs: ["ses_1"] })
    expect(
      sessionTabsRemovedForServerEvent({
        server: remote,
        directory: "/tmp/project",
        event: { type: "session.updated", properties: { info: { id: "ses_2", time: { archived: 1 } } } },
      }),
    ).toEqual({ server: remote, directory: "/tmp/project", sessionIDs: ["ses_2"] })
  })
})
