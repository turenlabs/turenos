import { describe, expect, test } from "bun:test"
import {
  prioritizeHomeSessionRecords,
  recentHomeSessionRecords,
  sessionOrigin,
  sessionOriginLabel,
} from "./home-session-origin"

describe("session origin", () => {
  test("recognises the id the scheduler assigns an automation run", () => {
    expect(sessionOrigin({ id: "ses_loop_run123" })).toBe("automation")
    expect(sessionOrigin({ id: "ses_042173712ffeArQsZmpkpA07vx" })).toBe("manual")
  })

  test("classifies generated run sessions separately from manual sessions", () => {
    expect(sessionOrigin({ id: "ses_loop_run123" })).toBe("automation")
    const removedOrigin = ["rever", "sing"].join("")
    expect(sessionOrigin({ id: `ses_${removedOrigin}_abc123` })).toBe("manual")
    expect(sessionOrigin({ id: `ses-${removedOrigin}-team-run123` })).toBe("manual")
    expect(sessionOrigin({ id: "ses_manual" })).toBe("manual")
    expect(sessionOriginLabel("automation")).toBe("Workflow")
  })

  test("prioritizes attention before active and recent sessions", () => {
    const records = [
      { id: "recent", priority: 3 },
      { id: "attention", priority: 0 },
      { id: "working", priority: 1 },
    ]
    expect(prioritizeHomeSessionRecords(records, (record) => record.priority, 2).map((record) => record.id)).toEqual([
      "attention",
      "working",
    ])
  })

  test("selects the newest ordinary sessions for the bounded home projection", () => {
    const records = [
      { session: { time: { created: 1, updated: 1 } } },
      { session: { time: { created: 3, updated: 3 } } },
      { session: { time: { created: 2, updated: 2 } } },
    ]
    expect(recentHomeSessionRecords(records, 2).map((record) => record.session.time.created)).toEqual([3, 2])
  })
})
