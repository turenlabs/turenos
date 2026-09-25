import { describe, expect, test } from "bun:test"
import { modelCapabilitySummary, modelEffortDefaultIndex, modelEffortDisplay } from "./model-selection-display"

describe("model effort display", () => {
  test.each([
    ["default", "Default", "No level sent; the provider decides"],
    ["none", "None", "Disable extra reasoning"],
    ["medium", "Balanced", "Everyday coding and debugging"],
    ["high", "Thorough", "Complex changes and careful review"],
    ["xhigh", "Deep", "Hard problems; slower and more detailed"],
    ["max", "Maximum", "Most careful analysis; slowest"],
  ])("explains %s without exposing provider jargon", (value, label, description) => {
    expect(modelEffortDisplay(value)).toEqual({ label, description })
  })

  test("humanizes provider-specific variants", () => {
    expect(modelEffortDisplay("thinking_fast")).toEqual({
      label: "Thinking Fast",
      description: "Provider-specific mode",
    })
  })

  test("starts manual control at medium when available", () => {
    expect(modelEffortDefaultIndex(["none", "low", "medium", "high", "max"])).toBe(2)
  })

  test("starts manual control at the center for provider-specific variants", () => {
    expect(modelEffortDefaultIndex(["quick", "normal", "careful", "maximum"])).toBe(1)
  })
})

describe("model capability summary", () => {
  test("describes reasoning and image support", () => {
    expect(modelCapabilitySummary({ capabilities: { reasoning: true, input: { image: true } } })).toBe(
      "Complex coding, debugging, and image analysis",
    )
  })

  test("supports legacy modality data", () => {
    expect(modelCapabilitySummary({ reasoning: false, modalities: { input: ["text", "image"] } })).toBe(
      "Coding and questions with image support",
    )
  })
})
