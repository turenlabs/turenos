import { describe, expect, test } from "bun:test"
import {
  applySessionGoalSnapshot,
  clearSessionGoalSnapshot,
  formatSessionGoalDuration,
  parseSessionGoalCommand,
  resolveSessionGoalSubmission,
  sessionGoalSubmissionMutation,
  sessionGoalElapsedSeconds,
  sessionGoalObjectiveError,
  type SessionGoalInfo,
} from "./session-goal"

const goal = (input: Partial<SessionGoalInfo> = {}): SessionGoalInfo => ({
  id: "goal_1",
  sessionID: "ses_1",
  revision: 1,
  objective: "Finish the migration",
  status: "active",
  tokensUsed: 240,
  timeUsedSeconds: 15,
  time: {
    created: 1_000,
    updated: 2_000,
    statusChanged: 10_000,
  },
  ...input,
})

describe("parseSessionGoalCommand", () => {
  test("recognizes the bare toggle and lifecycle commands", () => {
    expect(parseSessionGoalCommand("/goal")).toEqual({ type: "toggle" })
    expect(parseSessionGoalCommand(" /GOAL edit ")).toEqual({ type: "edit" })
    expect(parseSessionGoalCommand("/goal pause")).toEqual({ type: "pause" })
    expect(parseSessionGoalCommand("/goal resume")).toEqual({ type: "resume" })
    expect(parseSessionGoalCommand("/goal clear")).toEqual({ type: "clear" })
  })

  test("preserves a multiline objective without treating command prefixes as matches", () => {
    expect(parseSessionGoalCommand("/goal Ship the slice\nand keep tests green")).toEqual({
      type: "set",
      objective: "Ship the slice\nand keep tests green",
    })
    expect(parseSessionGoalCommand("/goals nope")).toBeUndefined()
  })

  test("treats normal text as an objective only while goal mode is active", () => {
    expect(resolveSessionGoalSubmission("Ship it", false)).toBeUndefined()
    expect(resolveSessionGoalSubmission(" Ship it ", true)).toEqual({ type: "set", objective: "Ship it" })
    expect(resolveSessionGoalSubmission("/goal pause", true)).toEqual({ type: "pause" })
  })

  test("edits unfinished goals and starts a new identity after completion", () => {
    expect(sessionGoalSubmissionMutation(goal({ status: "active" }))).toBe("edit")
    expect(sessionGoalSubmissionMutation(goal({ status: "paused" }))).toBe("edit")
    expect(sessionGoalSubmissionMutation(goal({ status: "complete" }))).toBe("start")
    expect(sessionGoalSubmissionMutation(undefined)).toBe("start")
  })
})

describe("session goal presentation", () => {
  test("validates the durable objective boundary", () => {
    expect(sessionGoalObjectiveError("  ")).toBe("required")
    expect(sessionGoalObjectiveError("x".repeat(4_001))).toBe("tooLong")
    expect(sessionGoalObjectiveError("x".repeat(4_000))).toBeUndefined()
  })

  test("shows persisted elapsed time without double counting active accounting checkpoints", () => {
    expect(sessionGoalElapsedSeconds(goal())).toBe(15)
    expect(sessionGoalElapsedSeconds(goal({ status: "paused" }))).toBe(15)
  })

  test("formats compact elapsed durations", () => {
    expect(formatSessionGoalDuration(7)).toBe("7s")
    expect(formatSessionGoalDuration(125)).toBe("2m 5s")
    expect(formatSessionGoalDuration(7_440)).toBe("2h 4m")
  })
})

describe("session goal hydration races", () => {
  test("does not let a stale GET replace a newer live event", () => {
    const live = goal({ revision: 3, objective: "Live objective" })
    expect(applySessionGoalSnapshot(live, goal({ revision: 2, objective: "Stale objective" }))).toBe(live)
  })

  test("lets a newer goal identity replace a terminal snapshot", () => {
    const next = goal({ id: "goal_2", revision: 1, objective: "Next objective" })
    expect(applySessionGoalSnapshot(goal({ status: "complete", revision: 4 }), next)).toBe(next)
  })

  test("ignores stale clear events and applies the matching clear revision", () => {
    const current = goal({ revision: 3 })
    expect(clearSessionGoalSnapshot(current, { goalID: current.id, revision: 2 })).toBe(current)
    expect(clearSessionGoalSnapshot(current, { goalID: current.id, revision: 3 })).toBeUndefined()
  })
})
