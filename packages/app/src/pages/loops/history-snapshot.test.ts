import { expect, test } from "bun:test"
import { latestRunsAcross, outcomeLine, finalExcerpt } from "./latest-runs-data"
import { runSteps, runProgressLabel, failedCallout, stepDisplay, stepChipFor } from "./run-view"
import type { LoopRun } from "./api"

const original = [
  { id: "inspect", name: "Inspect", type: "agent" as const, prompt: "Inspect changes" },
  {
    id: "publish",
    name: "Publish",
    type: "agent" as const,
    prompt: "Publish {{ steps.inspect.output }}",
    when: "{{ steps.inspect.output.ready }}",
  },
]

test("historical run summary uses the executed workflow after current workflow is reordered", () => {
  const run = {
    id: "run_fixture",
    loopID: "loop_fixture",
    scheduledAt: 1000,
    status: "succeeded",
    trigger: "manual",
    currentStep: 2,
    time: { created: 1000, updated: 2000 },
    outputs: {
      inspect: { text: "intermediate findings", artifacts: [] },
      publish: { text: "FINAL report", artifacts: [] },
    },
    execution: {
      title: "Original",
      prompt: "Inspect",
      location: { directory: "/fixture" },
      workflow: { version: 1, steps: original, delivery: { type: "turen" } },
    },
  } as LoopRun
  const latest = latestRunsAcross(
    [
      {
        automation: {
          id: "loop_fixture",
          name: "Edited",
          workflow: {
            version: 1,
            steps: [
              { ...original[1], prompt: "Independent publish", when: undefined },
              original[0],
              { id: "new", name: "New", type: "agent", prompt: "New task" },
            ],
            delivery: { type: "turen" },
          },
        },
        runs: [run],
      },
    ],
    10,
  )[0]
  expect({ summary: outcomeLine(latest.run, latest.steps), excerpt: finalExcerpt(latest.run, latest.steps) }).toEqual({
    summary: "2 of 2 done",
    excerpt: "FINAL report",
  })
})

test("active and failed run labels retain original names and positions", () => {
  const run = {
    id: "run_fixture",
    loopID: "loop_fixture",
    scheduledAt: 1000,
    status: "running",
    trigger: "manual",
    currentStep: 1,
    time: { created: 1000, updated: 2000 },
    outputs: {},
    execution: {
      title: "Original",
      prompt: "Inspect",
      location: { directory: "/fixture" },
      workflow: { version: 1, steps: original, delivery: { type: "turen" } },
    },
  } as LoopRun
  const automation = {
    workflow: {
      version: 1 as const,
      steps: [{ ...original[1], name: "Changed" }],
      delivery: { type: "turen" as const },
    },
  }
  const steps = runSteps(run, automation)
  expect(runProgressLabel(run, steps)).toBe("Step 2 of 2 · Publish")
  expect(failedCallout({ ...run, status: "failed" }, steps)).toBe("Failed at step 2 · Publish")
  expect(stepDisplay("publish", steps, 2)).toEqual({ name: "Publish", index: 1, total: 2 })
  expect(stepChipFor(run, "publish", 0)?.label).toBe("running")
  expect(stepChipFor(run, "inspect", 1)?.label).toBe("pending")
  expect(stepChipFor(run, "added", 1)).toBeUndefined()
})

test("older runs fall back only when no execution snapshot exists", () => {
  const run = { outputs: {} } as LoopRun
  const automation = { workflow: { version: 1 as const, steps: original, delivery: { type: "turen" as const } } }
  expect(runSteps(run, automation)).toEqual(original)
  expect(runSteps(run)).toEqual([])
  expect(
    runSteps(
      { ...run, execution: { title: "Prompt run", prompt: "Task", location: { directory: "/fixture" } } },
      automation,
    ),
  ).toEqual([])
})
