import { describe, expect, test } from "bun:test"
import {
  agentDraft,
  deriveStepID,
  renameStep,
  rewriteBindings,
  skillDraft,
  toDrafts,
  toWorkflowSteps,
} from "./workflow"

describe("deriveStepID", () => {
  test("slugifies names into expression-safe IDs", () => {
    expect(deriveStepID("Gather updates", [])).toBe("gather_updates")
    expect(deriveStepID("  CI: triage & fix!  ", [])).toBe("ci_triage_fix")
    expect(deriveStepID("2nd pass", [])).toBe("nd_pass")
    expect(deriveStepID("", [])).toBe("step")
    expect(deriveStepID("42", [])).toBe("step")
  })

  test("every derived ID satisfies the server pattern", () => {
    for (const name of ["Gather updates", "___", "9 lives", "é è ü", "a-b.c"])
      expect(deriveStepID(name, [])).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
  })

  test("dedupes against taken IDs with numeric suffixes", () => {
    expect(deriveStepID("Research", ["research"])).toBe("research_2")
    expect(deriveStepID("Research", ["research", "research_2"])).toBe("research_3")
  })
})

describe("rewriteBindings", () => {
  test("rewrites only bindings that reference the renamed step", () => {
    const template =
      "Use {{ steps.old.output }} and {{ steps.old.output.summary }} but not {{ steps.older.output }} or {{ trigger.type }}"
    expect(rewriteBindings(template, "old", "fresh")).toBe(
      "Use {{ steps.fresh.output }} and {{ steps.fresh.output.summary }} but not {{ steps.older.output }} or {{ trigger.type }}",
    )
  })

  test("preserves whitespace variants and artifacts paths", () => {
    expect(rewriteBindings("{{steps.old.artifacts}} {{  steps.old.output  }}", "old", "fresh")).toBe(
      "{{steps.fresh.artifacts}} {{  steps.fresh.output  }}",
    )
  })
})

describe("renameStep", () => {
  test("re-derives the ID and rewrites downstream references", () => {
    const [research, write] = [
      agentDraft([], "Research", "Find changes"),
      agentDraft(["research"], "Write", "Summarize {{ steps.research.output }}"),
    ]
    const renamed = renameStep([research, write], research.key, "Deep research")
    expect(renamed[0]).toMatchObject({ id: "deep_research", name: "Deep research" })
    expect(renamed[1].type === "agent" && renamed[1].prompt).toBe("Summarize {{ steps.deep_research.output }}")
  })

  test("keeps the ID stable when the rename produces the same slug", () => {
    const step = agentDraft([], "Research", "prompt")
    const renamed = renameStep([step], step.key, "research")
    expect(renamed[0].id).toBe("research")
  })

  test("rewrites skill instructions too", () => {
    const research = agentDraft([], "Research", "Find changes")
    const skill = { ...skillDraft(["research"]), instructions: "Context: {{ steps.research.output }}" }
    const renamed = renameStep([research, skill], research.key, "Gather")
    expect(renamed[1].type === "skill" && renamed[1].instructions).toBe("Context: {{ steps.gather.output }}")
  })
})

describe("draft round-trip", () => {
  test("wraps persisted steps and strips keys on save", () => {
    const steps = [{ id: "check", type: "agent" as const, name: "Check", prompt: "Check things" }]
    const drafts = toDrafts(steps)
    expect(drafts[0].key).toBeTruthy()
    expect(toWorkflowSteps(drafts)).toEqual(steps)
  })
})
