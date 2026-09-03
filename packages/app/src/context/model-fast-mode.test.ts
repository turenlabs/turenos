import { describe, expect, test } from "bun:test"
import { carryFastModeVariant, getFastMode, isFastModePair } from "./model-fast-mode"

const provider = { id: "openai" }
const base = { id: "gpt-5", name: "GPT-5", api: { id: "gpt-5" }, provider }
const fast = { id: "gpt-5-fast", name: "GPT-5 Fast", api: { id: "gpt-5" }, provider }

describe("model fast mode", () => {
  test("finds the base and fast models from either selection", () => {
    expect(getFastMode(base, [base, fast])).toEqual({ base, fast, enabled: false })
    expect(getFastMode(fast, [base, fast])).toEqual({ base, fast, enabled: true })
  })

  test("requires a published base and fast pair from the same provider", () => {
    expect(getFastMode(base, [base])).toBeUndefined()
    expect(getFastMode(base, [base, { ...fast, provider: { id: "gateway" } }])).toBeUndefined()
    expect(getFastMode({ ...base, id: "gpt-5-pro" }, [base, fast])).toBeUndefined()
  })

  test("identifies only base-to-fast model switches", () => {
    expect(isFastModePair(base, fast)).toBe(true)
    expect(isFastModePair(base, { ...fast, id: "gpt-5-pro" })).toBe(false)
    expect(isFastModePair(base, base)).toBe(false)
    expect(isFastModePair(fast, fast)).toBe(false)
  })

  test("preserves explicit, effective, and default variant choices", () => {
    expect(carryFastModeVariant({ selected: "high", effective: undefined, variants: ["high"] })).toBe("high")
    expect(carryFastModeVariant({ selected: undefined, effective: "high", variants: ["high"] })).toBe("high")
    expect(carryFastModeVariant({ selected: null, effective: "high", variants: ["high"] })).toBeNull()
    expect(carryFastModeVariant({ selected: "high", effective: undefined, variants: ["low"] })).toBeUndefined()
  })
})
