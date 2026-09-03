import { describe, expect, test } from "bun:test"
import { renderWorkflowStep } from "../../src/loop/scheduler"

describe("LoopScheduler Automation workflow", () => {
  test("renders ordered agent and skill steps for Turen delivery", () => {
    const first = renderWorkflowStep(
      { id: "inspect", name: "Inspect CI", type: "agent", prompt: "Find the first actionable failure." },
      0,
      2,
    )
    const final = renderWorkflowStep(
      {
        id: "sweep",
        name: "Run CI skill",
        type: "skill",
        skill: "ci-sweeper",
        instructions: "Only report actionable failures.",
      },
      1,
      2,
    )

    expect(first).toContain("Automation step 1 of 2: Inspect CI")
    expect(first).toContain("Find the first actionable failure.")
    expect(first).not.toContain("delivered inside TurenOS")
    expect(final).toContain("Automation step 2 of 2: Run CI skill")
    expect(final).toContain('Load and follow the "ci-sweeper" skill.')
    expect(final).toContain("Additional instructions: Only report actionable failures.")
    expect(final).toContain("delivered inside TurenOS")
  })
})
