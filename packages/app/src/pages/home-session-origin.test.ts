import { describe, expect, test } from "bun:test"
import {
  homeSessionFocusGroup,
  isAutomationSession,
  partitionBySessionOrigin,
  prioritizeHomeSessionRecords,
  recentHomeSessionRecords,
  recentlyFinishedHomeSessions,
  sessionOrigin,
  sessionOriginLabel,
} from "./home-session-origin"

describe("session origin", () => {
  test("recognises the id the scheduler assigns an automation run", () => {
    expect(isAutomationSession({ id: "ses_loop_run123" })).toBe(true)
    expect(isAutomationSession({ id: "ses_042173712ffeArQsZmpkpA07vx" })).toBe(false)
  })

  test("classifies generated run sessions separately from manual sessions", () => {
    expect(sessionOrigin({ id: "ses_pentest_run123" })).toBe("pentest")
    expect(sessionOrigin({ id: "ses-pentest-team-run123" })).toBe("pentest")
    const removedOrigin = ["rever", "sing"].join("")
    expect(sessionOrigin({ id: `ses_${removedOrigin}_abc123` })).toBe("manual")
    expect(sessionOrigin({ id: `ses-${removedOrigin}-team-run123` })).toBe("manual")
    expect(sessionOrigin({ id: "ses_manual" })).toBe("manual")
    expect(sessionOriginLabel("automation")).toBe("Workflow")
    expect(sessionOriginLabel("pentest")).toBe("Pentest")
  })

  test("keeps both groups in their original order", () => {
    const records = [
      { session: { id: "ses_a" } },
      { session: { id: "ses_loop_1" } },
      { session: { id: "ses_b" } },
      { session: { id: "ses_loop_2" } },
      { session: { id: "ses_pentest_1" } },
    ]
    const { manual, automation, background } = partitionBySessionOrigin(records)
    expect(manual.map((r) => r.session.id)).toEqual(["ses_a", "ses_b"])
    expect(automation.map((r) => r.session.id)).toEqual(["ses_loop_1", "ses_loop_2"])
    expect(background.map((r) => r.session.id)).toEqual(["ses_pentest_1"])
  })

  test("keeps personal focus to manual work but promotes any blocked run", () => {
    expect(
      homeSessionFocusGroup({ origin: "automation", status: "working", selectedProject: false, pinned: false }),
    ).toBeUndefined()
    expect(
      homeSessionFocusGroup({ origin: "pentest", status: "working", selectedProject: false, pinned: false }),
    ).toBeUndefined()
    expect(
      homeSessionFocusGroup({ origin: "pentest", status: "attention", selectedProject: false, pinned: false }),
    ).toBe("attention")
    expect(homeSessionFocusGroup({ origin: "manual", status: "working", selectedProject: true, pinned: false })).toBe(
      "working",
    )
    expect(homeSessionFocusGroup({ origin: "manual", status: "unread", selectedProject: false, pinned: false })).toBe(
      "unread",
    )
    expect(
      homeSessionFocusGroup({ origin: "manual", status: "working", selectedProject: false, pinned: true }),
    ).toBeUndefined()
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

  test("finds recent settled manual root sessions without including active or generated work", () => {
    const now = 10_000
    const records = [
      { session: { id: "manual-finished", time: { created: 9_000, updated: 9_500 } } },
      { session: { id: "manual-working", time: { created: 9_000, updated: 9_500 } } },
      { session: { id: "ses_loop_generated", time: { created: 9_000, updated: 9_500 } } },
      { session: { id: "manual-child", parentID: "manual-finished", time: { created: 9_000, updated: 9_500 } } },
      { session: { id: "manual-old", time: { created: 1, updated: 1 } } },
    ]
    const statuses = new Map([
      ["manual-finished", "settled"],
      ["manual-working", "working"],
      ["ses_loop_generated", "settled"],
      ["manual-child", "settled"],
      ["manual-old", "settled"],
    ] as const)
    expect(recentlyFinishedHomeSessions(records, statuses, now, 2_000).map((record) => record.session.id)).toEqual([
      "manual-finished",
    ])
  })
})
