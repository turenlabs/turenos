import { describe, expect, test } from "bun:test"
import {
  applySessionTaskSnapshot,
  formatSessionTaskDuration,
  sessionTaskElapsedSeconds,
  sessionTaskIDs,
  sessionTaskRoot,
  sessionSwarmProgress,
  sessionSwarmRequest,
  sessionTaskThinkingProfiles,
  type SessionTaskInfo,
} from "./session-subagent"

describe("durable subagent presentation", () => {
  test("rejects stale snapshots without changing the permanent row identity", () => {
    const current = task({ revision: 2, status: "running", time: { ...time, updated: 3_000 } })
    const stale = task({ revision: 1, status: "starting" })

    expect(applySessionTaskSnapshot(current, stale)).toBe(current)
    expect(applySessionTaskSnapshot(current, task({ revision: 3, status: "completed" })).id).toBe(current.id)
  })

  test("keeps IDs ordered by durable creation time while status changes", () => {
    const first = task({ id: "tsk_first", time: { ...time, created: 1_000 } })
    const second = task({ id: "tsk_second", time: { ...time, created: 2_000 } })
    const tasks = { [second.id]: second, [first.id]: first }

    expect(sessionTaskIDs(tasks, rootID)).toEqual(["tsk_first", "tsk_second"])
    tasks[first.id] = task({ ...first, revision: 2, status: "completed" })
    expect(sessionTaskIDs(tasks, rootID)).toEqual(["tsk_first", "tsk_second"])
  })

  test("resolves a child session to the same root tree before a second hydration", () => {
    const owner = task({ childSessionID: childID })
    expect(sessionTaskRoot({ [owner.id]: owner }, {}, childID)).toBe(rootID)
    expect(sessionTaskRoot({}, { [childID]: rootID }, childID)).toBe(rootID)
    expect(sessionTaskRoot({}, {}, rootID)).toBe(rootID)
  })

  test("uses terminal timestamps for stable elapsed evidence", () => {
    const completed = task({
      status: "completed",
      time: { created: 1_000, updated: 8_000, started: 2_000, completed: 7_000 },
    })
    expect(sessionTaskElapsedSeconds(completed, 50_000)).toBe(5)
    expect(formatSessionTaskDuration(5)).toBe("5s")
    expect(formatSessionTaskDuration(65)).toBe("1m 5s")
    expect(formatSessionTaskDuration(3_665)).toBe("1h 1m")
  })

  test("gives concurrent siblings distinct animations that survive a reload", () => {
    const siblings = ["tsk_alpha", "tsk_bravo", "tsk_charlie", "tsk_delta"]
    const assigned = sessionTaskThinkingProfiles(siblings)

    expect(new Set(Object.values(assigned)).size).toBe(siblings.length)
    // Deterministic, so a reload (a fresh call with the same durable IDs) is identical.
    expect(sessionTaskThinkingProfiles(siblings)).toEqual(assigned)
    // A late sibling, or an earlier one finishing, must not renumber the existing rows.
    const grown = sessionTaskThinkingProfiles([...siblings, "tsk_echo"])
    siblings.forEach((id) => expect(grown[id]).toBe(assigned[id]!))
  })

  test("keeps assigning animations past the profile count without stalling", () => {
    const many = Array.from({ length: 14 }, (_, index) => `tsk_${index}`)
    const assigned = sessionTaskThinkingProfiles(many)

    expect(Object.keys(assigned)).toHaveLength(many.length)
    // Each full block of six is collision-free, which is what a bounded fan-out sees.
    expect(new Set(many.slice(0, 6).map((id) => assigned[id]!)).size).toBe(6)
    expect(new Set(many.slice(6, 12).map((id) => assigned[id]!)).size).toBe(6)
  })

  test("renders zero rather than NaN when durable timestamps are absent", () => {
    const missing = task({ status: "running", time: {} as SessionTaskInfo["time"] })
    expect(sessionTaskElapsedSeconds(missing, 10_000)).toBe(0)
    expect(formatSessionTaskDuration(sessionTaskElapsedSeconds(missing, 10_000))).toBe("0s")
    expect(formatSessionTaskDuration(Number.NaN)).toBe("0s")
  })

  test("projects swarm lifecycle, lanes, failures, cancellation, and evidence freshness", () => {
    const progress = sessionSwarmProgress(
      {
        status: "ready",
        objective: "Compare competitors",
        count: 12,
        explicitCount: false,
      },
      [
        task({ id: "tsk_starting", status: "starting", description: "Primary sources" }),
        task({ id: "tsk_running", status: "running", description: "Workspace audit" }),
        task({ id: "tsk_complete", status: "completed", description: "UX review" }),
        task({ id: "tsk_failed", status: "failed", description: "Performance" }),
        task({ id: "tsk_cancelled", status: "cancelled", description: "Safety" }),
        task({ id: "tsk_interrupted", status: "interrupted", description: "Synthesis" }),
      ],
      [
        {
          id: "note_1",
          kind: "finding",
          title: "Evidence",
          body: "Found it",
          authorAgent: "research",
          timeCreated: 3_000,
          timeUpdated: 4_000,
        },
      ],
    )

    expect(progress).toMatchObject({
      status: "ready",
      objective: "Compare competitors",
      requested: 12,
      admitted: 1,
      running: 1,
      completed: 1,
      failed: 1,
      cancelled: 2,
      total: 6,
      lanes: ["Primary sources", "Workspace audit"],
      evidenceCount: 1,
      evidenceUpdatedAt: 4_000,
    })
  })

  test("ends swarm attribution at the next explicit user prompt", () => {
    expect(
      sessionSwarmRequest([
        { text: "@swarm 2 audit the implementation", time: 1_000 },
        { text: "Now handle an unrelated follow-up", time: 2_000 },
      ]),
    ).toBeUndefined()
    expect(sessionSwarmRequest([{ text: "@swarm 2 audit the implementation", time: 1_000 }])).toMatchObject({
      invocation: { status: "ready", count: 2 },
      time: 1_000,
    })
  })
})

const rootID = "ses_root"
const childID = "ses_child"
const time = { created: 1_000, updated: 2_000, started: 1_500 }

function task(overrides: Partial<SessionTaskInfo> = {}): SessionTaskInfo {
  return {
    id: "tsk_task",
    rootSessionID: rootID,
    parentSessionID: rootID,
    childSessionID: childID,
    agent: "adversarial-review",
    description: "Review the implementation",
    depth: 0,
    status: "running",
    revision: 1,
    time,
    ...overrides,
  }
}
