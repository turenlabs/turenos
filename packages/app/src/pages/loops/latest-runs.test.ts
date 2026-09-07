import { describe, expect, test } from "bun:test"
import {
  finalExcerpt,
  latestRunsAcross,
  nextRunLabel,
  outcomeLine,
  relativeAgo,
} from "./latest-runs-data"
import type { LoopInfo, LoopRun } from "./api"

const output = (text: string, json?: unknown): LoopRun["outputs"][string] => ({ text, json, artifacts: [] })

const run = (input: Partial<LoopRun>): LoopRun =>
  ({
    id: "run_1",
    loopID: "loop_1",
    scheduledAt: 1_000_000,
    status: "running",
    trigger: "scheduled",
    outputs: {},
    time: { created: 1_000_000, updated: 1_000_000 },
    ...input,
  }) as LoopRun

const steps = [
  { id: "collect", name: "Collect" },
  { id: "triage", name: "Triage" },
  { id: "summarize", name: "Summarize" },
] as const

const automation = (
  input: Partial<Pick<LoopInfo, "id" | "name" | "status" | "schedule" | "workflow" | "nextRunAt">> = {},
) => ({
  id: "loop_1",
  name: "CI failure triage",
  status: "active" as const,
  schedule: { type: "interval" as const, seconds: 1_800, timezone: "UTC" },
  ...input,
})

describe("relativeAgo", () => {
  test("names just-now, seconds, minutes, hours, and days", () => {
    expect(relativeAgo(1_000_000, 999_995)).toBe("just now")
    expect(relativeAgo(1_000_000, 955_000)).toBe("45s ago")
    expect(relativeAgo(1_000_000, 880_000)).toBe("2m ago")
    expect(relativeAgo(10_000_000, 2_800_000)).toBe("2h ago")
    expect(relativeAgo(500_000_000, 240_800_000)).toBe("3d ago")
  })

  test("clamps future timestamps to just now", () => {
    expect(relativeAgo(1_000, 2_000)).toBe("just now")
  })
})

describe("nextRunLabel", () => {
  test("counts down to the server-reported fire time", () => {
    expect(nextRunLabel(automation({ nextRunAt: 1_000_000 + 12 * 60_000 }), 1_000_000)).toBe("next run in 12m")
    expect(nextRunLabel(automation({ nextRunAt: 1_000_000 + 6 * 3_600_000 }), 1_000_000)).toBe("next run in 6h")
  })

  test("names paused automations and hides the rest", () => {
    expect(nextRunLabel(automation({ status: "paused" }))).toBe("paused")
    expect(nextRunLabel(automation({ status: "expired" }))).toBeUndefined()
    expect(nextRunLabel(automation({}))).toBeUndefined()
  })

  test("treats a past fire time as starting soon", () => {
    expect(nextRunLabel(automation({ nextRunAt: 999_000 }), 1_000_000)).toBe("starting soon")
  })
})

describe("outcomeLine", () => {
  test("names the failed step and the first error line", () => {
    const candidate = run({
      status: "failed",
      currentStep: 1,
      error: "overloaded_error, Anthropic API overloaded\nretry later",
      outputs: { collect: output("nightly") },
    })
    expect(outcomeLine(candidate, [...steps])).toBe(
      "failed · step 2 of 3 — overloaded_error, Anthropic API overloaded",
    )
  })

  test("tracks the active step and non-scheduled triggers", () => {
    const candidate = run({ status: "running", currentStep: 0, trigger: "manual", outputs: {} })
    expect(outcomeLine(candidate, [...steps])).toBe("running · step 1 of 3 · manual")
  })

  test("summarizes completed runs", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 3,
      outputs: { collect: output("a"), triage: output("b"), summarize: output("c") },
    })
    expect(outcomeLine(candidate, [...steps])).toBe("3 of 3 done")
  })

  test("passes terminal statuses through", () => {
    expect(outcomeLine(run({ status: "cancelled", outputs: {} }), [...steps])).toBe("cancelled")
    expect(outcomeLine(run({ status: "stale", outputs: {} }), [...steps])).toBe("stale")
  })
})

describe("finalExcerpt", () => {
  test("returns the last completed step output", () => {
    const candidate = run({
      status: "succeeded",
      currentStep: 3,
      outputs: { collect: output("first"), summarize: output("final report") },
    })
    expect(finalExcerpt(candidate, [...steps])).toBe("final report")
  })

  test("falls back to stringified JSON, then the run error", () => {
    const jsonOnly = run({ status: "succeeded", currentStep: 1, outputs: { collect: output("", { ok: true }) } })
    expect(finalExcerpt(jsonOnly, [...steps])).toBe('{\n  "ok": true\n}')
    const failed = run({ status: "failed", currentStep: 0, error: "boom", outputs: {} })
    expect(finalExcerpt(failed, [...steps])).toBe("boom")
  })

  test("truncates long outputs", () => {
    const candidate = run({ status: "succeeded", currentStep: 1, outputs: { collect: output("x".repeat(500)) } })
    const excerpt = finalExcerpt(candidate, [...steps], 100)
    expect(excerpt.length).toBeLessThanOrEqual(101)
    expect(excerpt.endsWith("…")).toBe(true)
  })
})

describe("latestRunsAcross", () => {
  test("merges newest-first across automations with a limit", () => {
    const first = automation({ id: "loop_1", name: "CI failure triage" })
    const second = automation({ id: "loop_2", name: "Daily Tech News" })
    const entries = [
      {
        automation: first,
        runs: [run({ id: "old", scheduledAt: 1_000 }), run({ id: "older", scheduledAt: 500 })],
      },
      { automation: second, runs: [run({ id: "new", loopID: "loop_2", scheduledAt: 2_000 })] },
    ]
    const latest = latestRunsAcross(entries, 2)
    expect(latest.map((item) => item.run.id)).toEqual(["new", "old"])
    expect(latest[0]?.loopName).toBe("Daily Tech News")
  })

  test("carries workflow step refs and tolerates empties", () => {
    expect(latestRunsAcross([], 3)).toEqual([])
    expect(latestRunsAcross([{ automation: automation({}), runs: [] }], 3)).toEqual([])
  })
})
