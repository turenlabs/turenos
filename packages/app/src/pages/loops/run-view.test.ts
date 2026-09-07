import { describe, expect, test } from "bun:test"
import {
  currentStepIndex,
  failedCallout,
  failedStep,
  isActiveRun,
  latestRunTone,
  orderedStepOutputs,
  runProgressLabel,
  runTotal,
  stepChipFor,
  stepDisplay,
  stepState,
  triggerSummary,
} from "./run-view"
import type { LoopRun } from "./api"
import type { TriggerDraft } from "./trigger"

const output = (text: string): LoopRun["outputs"][string] => ({ text, artifacts: [] })

const run = (input: Partial<LoopRun> & { outputs: LoopRun["outputs"] }): LoopRun =>
  ({
    id: "run_1",
    loopID: "loop_1",
    scheduledAt: 1_000,
    status: "running",
    trigger: "scheduled",
    time: { created: 1_000, updated: 1_000 },
    ...input,
  }) as LoopRun

const steps = [
  { id: "research", name: "Research" },
  { id: "write", name: "Write" },
  { id: "review", name: "Review" },
] as const

const draft = (input: Partial<TriggerDraft>): TriggerDraft => ({
  kind: "interval",
  interval: "1h",
  cronExpression: "",
  timezone: "UTC",
  eventPaths: "",
  debounceMs: "",
  sessionOutcomes: "both",
  sessionID: "",
  eventAgent: "",
  ...input,
})

describe("orderedStepOutputs", () => {
  test("returns entries in workflow order regardless of received order", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 3,
      outputs: { review: output("c"), research: output("a"), write: output("b") },
    })
    expect(orderedStepOutputs(candidate, [...steps]).map(([id]) => id)).toEqual(["research", "write", "review"])
  })

  test("every step output is reachable, not just the first step", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 3,
      outputs: { research: output("a"), write: output("b"), review: output("c") },
    })
    const entries = orderedStepOutputs(candidate, [...steps])
    expect(entries).toHaveLength(3)
    expect(entries.map(([, value]) => value.text)).toEqual(["a", "b", "c"])
  })

  test("surfaces a later step output on its own", () => {
    const candidate = run({ outputs: { review: output("c") } })
    expect(orderedStepOutputs(candidate, [...steps]).map(([id]) => id)).toEqual(["review"])
  })

  test("trails outputs from removed steps in received order", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 2,
      outputs: { gone_b: output("old-b"), write: output("b"), research: output("a"), gone_a: output("old-a") },
    })
    expect(orderedStepOutputs(candidate, [...steps]).map(([id]) => id)).toEqual([
      "research",
      "write",
      "gone_b",
      "gone_a",
    ])
  })

  test("returns no entries when the run has no outputs", () => {
    expect(orderedStepOutputs(run({ outputs: {} }), [...steps])).toEqual([])
  })
})

describe("stepDisplay", () => {
  test("resolves the workflow name and 0-based index for a known step", () => {
    expect(stepDisplay("write", [...steps], 3)).toEqual({ name: "Write", index: 1, total: 3 })
  })

  test("falls back to the raw step ID at index 0 for removed steps", () => {
    expect(stepDisplay("gone", [...steps], 4)).toEqual({ name: "gone", index: 0, total: 4 })
  })

  test("every entry of a multi-step run resolves a distinct card", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 3,
      outputs: { research: output("a"), write: output("b"), review: output("c") },
    })
    const cards = orderedStepOutputs(candidate, [...steps]).map(([id]) => stepDisplay(id, [...steps], 3))
    expect(cards.map((card) => card.name)).toEqual(["Research", "Write", "Review"])
    expect(cards.map((card) => card.index)).toEqual([0, 1, 2])
  })
})

describe("stepState", () => {
  test("marks steps with outputs done even on failed or active runs", () => {
    const failed = run({ status: "failed", currentStep: 1, outputs: { research: output("a") } })
    expect(stepState(failed, "research", 0)).toBe("done")
    const active = run({ status: "running", currentStep: 0, outputs: { research: output("a") } })
    expect(stepState(active, "research", 0)).toBe("done")
  })

  test("marks the current step failed on a failed run", () => {
    const candidate = run({ status: "failed", currentStep: 1, outputs: { research: output("a") } })
    expect(stepState(candidate, "write", 1)).toBe("failed")
    expect(stepState(candidate, "review", 2)).toBe("pending")
  })

  test("marks the current step active on running and claimed runs", () => {
    expect(stepState(run({ status: "running", currentStep: 1, outputs: {} }), "write", 1)).toBe("active")
    expect(stepState(run({ status: "claimed", currentStep: 0, outputs: {} }), "research", 0)).toBe("active")
  })

  test("leaves future steps pending on finished runs", () => {
    const candidate = run({ status: "succeeded", currentStep: 3, outputs: { research: output("a") } })
    expect(stepState(candidate, "review", 2)).toBe("pending")
  })

  test("treats a missing currentStep as step 0", () => {
    const candidate = run({ status: "failed", outputs: {} })
    expect(stepState(candidate, "research", 0)).toBe("failed")
  })
})

describe("currentStepIndex", () => {
  test("passes through valid indexes and normalizes the rest to 0", () => {
    expect(currentStepIndex(run({ currentStep: 2, outputs: {} }))).toBe(2)
    expect(currentStepIndex(run({ outputs: {} }))).toBe(0)
    expect(currentStepIndex(run({ currentStep: -1, outputs: {} }))).toBe(0)
    expect(currentStepIndex(run({ currentStep: 1.5, outputs: {} }))).toBe(0)
  })
})

describe("isActiveRun", () => {
  test("is true only for running and claimed runs", () => {
    expect(isActiveRun(run({ status: "running", outputs: {} }))).toBe(true)
    expect(isActiveRun(run({ status: "claimed", outputs: {} }))).toBe(true)
    for (const status of ["succeeded", "failed", "cancelled", "skipped", "stale"] as const)
      expect(isActiveRun(run({ status, outputs: {} }))).toBe(false)
  })
})

describe("failedStep", () => {
  test("names the failing step by workflow name", () => {
    expect(failedStep(run({ status: "failed", currentStep: 1, outputs: {} }), [...steps])).toEqual({
      index: 1,
      name: "Write",
    })
  })

  test("falls back to the step ID, then to a positional name", () => {
    expect(failedStep(run({ status: "failed", currentStep: 0, outputs: {} }), [{ id: "research", name: "" }])).toEqual({
      index: 0,
      name: "research",
    })
    expect(failedStep(run({ status: "failed", currentStep: 4, outputs: {} }), [...steps])).toEqual({
      index: 4,
      name: "step 5",
    })
  })

  test("is undefined for non-failed runs", () => {
    expect(failedStep(run({ status: "running", currentStep: 1, outputs: {} }), [...steps])).toBeUndefined()
  })
})

describe("failedCallout", () => {
  test("names the failed step and appends the error", () => {
    const candidate = run({ status: "failed", currentStep: 1, error: "boom", outputs: { research: output("a") } })
    expect(failedCallout(candidate, [...steps])).toBe("Failed at step 2 · Write: boom")
  })

  test("omits the suffix when the run has no error", () => {
    expect(failedCallout(run({ status: "failed", currentStep: 2, outputs: {} }), [...steps])).toBe(
      "Failed at step 3 · Review",
    )
  })

  test("is undefined for non-failed runs", () => {
    expect(failedCallout(run({ status: "succeeded", currentStep: 3, outputs: {} }), [...steps])).toBeUndefined()
  })
})

describe("runTotal", () => {
  test("prefers workflow length, then output count, then one", () => {
    expect(runTotal(run({ outputs: {} }), [...steps])).toBe(3)
    expect(runTotal(run({ outputs: { a: output("a"), b: output("b") } }), [])).toBe(2)
    expect(runTotal(run({ outputs: {} }), [])).toBe(1)
  })
})

describe("runProgressLabel", () => {
  test("labels the active step by name", () => {
    expect(runProgressLabel(run({ status: "running", currentStep: 1, outputs: {} }), [...steps])).toBe(
      "Step 2 of 3 · Write",
    )
    expect(runProgressLabel(run({ status: "claimed", currentStep: 0, outputs: {} }), [...steps])).toBe(
      "Step 1 of 3 · Research",
    )
  })

  test("is undefined for finished runs", () => {
    for (const status of ["succeeded", "failed", "cancelled", "skipped", "stale"] as const)
      expect(runProgressLabel(run({ status, currentStep: 1, outputs: {} }), [...steps])).toBeUndefined()
  })

  test("clamps the step number to the total and omits unknown names", () => {
    expect(runProgressLabel(run({ status: "running", currentStep: 9, outputs: {} }), [...steps])).toBe("Step 3 of 3")
    expect(runProgressLabel(run({ status: "running", currentStep: 0, outputs: {} }), [])).toBe("Step 1 of 1")
  })
})

describe("latestRunTone", () => {
  test("tones failed runs red, succeeded muted, and everything else amber", () => {
    expect(latestRunTone("failed")).toContain("danger")
    expect(latestRunTone("succeeded")).toContain("muted")
    for (const status of ["claimed", "running", "cancelled", "skipped", "stale"] as const)
      expect(latestRunTone(status)).toContain("warning")
  })
})

describe("stepChipFor", () => {
  test("maps inferred step states to canvas chip labels", () => {
    const active = run({ status: "running", currentStep: 1, outputs: { research: output("a") } })
    expect(stepChipFor(active, "research", 0).label).toBe("done")
    expect(stepChipFor(active, "write", 1).label).toBe("running")
    expect(stepChipFor(active, "review", 2).label).toBe("pending")
    const failed = run({ status: "failed", currentStep: 1, outputs: { research: output("a") } })
    expect(stepChipFor(failed, "write", 1).label).toBe("failed")
  })
})

describe("triggerSummary", () => {
  test("summarizes every trigger kind", () => {
    expect(triggerSummary(draft({}))).toBe("Every 1h")
    expect(triggerSummary(draft({ kind: "cron", cronExpression: "*/5 * * * *" }))).toBe("Cron */5 * * * *")
    expect(triggerSummary(draft({ kind: "file-change", eventPaths: "src/**/*.ts\ntests/**/*.ts" }))).toBe(
      "On file change · 2 paths",
    )
    expect(triggerSummary(draft({ kind: "session-end" }))).toBe("On session end")
  })

  test("flags unset interval, cron, and file-change triggers", () => {
    expect(triggerSummary(draft({ interval: "" }))).toBe("Every Not set")
    expect(triggerSummary(draft({ kind: "cron", cronExpression: "   " }))).toBe("Cron · not set")
    expect(triggerSummary(draft({ kind: "file-change", eventPaths: "\n  \n" }))).toBe("On file change · not set")
    expect(triggerSummary(draft({ kind: "file-change", eventPaths: "src/**/*.ts" }))).toBe(
      "On file change · 1 path",
    )
  })
})
