import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "./server"
import { promoteDraftTab, type SessionTab, type Tab } from "./tab"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

const session = (sessionId: string): SessionTab => ({ type: "session", server, sessionId })
const draft = (draftID: string): Tab => ({ type: "draft", draftID, server, directory: "/repo" })

describe("draft tab promotion", () => {
  test("replaces the draft in place with one session tab", () => {
    const before: Tab[] = [session("before"), draft("draft-1"), session("after")]

    expect(promoteDraftTab(before, "draft-1", session("promoted"))).toEqual([
      session("before"),
      session("promoted"),
      session("after"),
    ])
  })

  test("prefers an existing matching session and removes the draft and duplicate sessions", () => {
    const existing = session("promoted")
    const before: Tab[] = [session("before"), draft("draft-1"), session("other"), existing, session("promoted")]
    const after = promoteDraftTab(before, "draft-1", session("promoted"))

    expect(after).toEqual([session("before"), existing, session("other")])
    expect(after[1]).toBe(existing)
  })

  test("still records the session if the draft disappeared before promotion", () => {
    expect(promoteDraftTab([session("other")], "missing", session("promoted"))).toEqual([
      session("other"),
      session("promoted"),
    ])
  })
})
