import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Run } from "../src/groups/loop"

// The HTTP success encoder must preserve the Core snapshot, not strip it.
test("run responses preserve execution workflow snapshots", () => {
  const execution = {
    title: "Original",
    prompt: "Inspect",
    location: { directory: "/fixture" },
    workflow: {
      version: 1,
      steps: [{ id: "inspect", name: "Inspect", type: "agent", prompt: "Inspect" }],
      delivery: { type: "turen" },
    },
  }
  const input = {
    id: "run_fixture",
    loopID: "loop_fixture",
    scheduledAt: 1000,
    status: "succeeded",
    trigger: "manual",
    currentStep: 1,
    outputs: {},
    time: { created: 1000, updated: 2000 },
    execution,
  }
  const decoded = Schema.decodeUnknownSync(Run)(input)
  expect(Schema.encodeSync(Run)(decoded)).toMatchObject({ execution })
})
