import { describe, expect, test } from "bun:test"
import { GoalContext } from "@turenlabs/core/session/runner/goal-context"

describe("SessionGoalContext", () => {
  test("keeps routine loop reminders constant-size", () => {
    const reminder = GoalContext.reminder()

    expect(reminder.length).toBeLessThan(500)
    expect(reminder).not.toContain("<objective>")
    expect(reminder).toContain("call get_goal")
  })

  test("keeps the full objective at bounded-turn re-anchoring", () => {
    const objective = "Preserve the complete objective <without drift>"
    const prompt = GoalContext.continuation({ objective })

    expect(prompt).toContain("Preserve the complete objective &lt;without drift&gt;")
  })
})
