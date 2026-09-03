import { describe, expect, test } from "bun:test"
import {
  carryModelVariant,
  cycleModelVariant,
  getConfiguredAgentVariant,
  resolveEffectiveModelVariant,
  resolveModelVariant,
} from "./model-variant"

describe("model variant", () => {
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("treats a legacy null selection as inherited configuration", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("xhigh")
  })

  test("does not revive a saved manual variant from a legacy null selection", () => {
    const value = resolveEffectiveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: undefined,
      saved: "high",
    })

    expect(value).toBeUndefined()
  })

  test("uses a saved per-model variant when selection is unset", () => {
    const value = resolveEffectiveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: undefined,
      saved: "high",
    })

    expect(value).toBe("high")
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from a legacy null selection through the configured variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })
})

// A variant that follows a model switch reaches the runner as a variant that model never
// published. Because the selection is persisted onto the session, that does not fail one
// turn — it fails every turn until stored state is edited.
describe("carryModelVariant", () => {
  const kimi = { providerID: "kimi-for-coding", modelID: "k3" }
  const openai = { providerID: "openai", modelID: "gpt-5.6-sol" }

  test("keeps the variant when the model is unchanged", () => {
    expect(carryModelVariant({ previous: kimi, next: { ...kimi }, variant: "max" })).toBe("max")
  })

  test("drops the variant when the model changes", () => {
    expect(carryModelVariant({ previous: kimi, next: openai, variant: "max" })).toBeUndefined()
  })

  test("drops the variant when only the provider changes", () => {
    expect(
      carryModelVariant({ previous: kimi, next: { providerID: "moonshot", modelID: "k3" }, variant: "max" }),
    ).toBeUndefined()
  })

  test("drops the variant when the model is cleared", () => {
    expect(carryModelVariant({ previous: kimi, next: undefined, variant: "max" })).toBeUndefined()
  })

  test("reports no variant when the previous model is unknown", () => {
    expect(carryModelVariant({ previous: undefined, next: kimi, variant: "max" })).toBeUndefined()
  })

  test("keeps a legacy automatic choice when the model is unchanged", () => {
    expect(carryModelVariant({ previous: kimi, next: { ...kimi }, variant: null })).toBeNull()
  })
})
