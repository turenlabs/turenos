import { describe, expect, test } from "bun:test"
import { contextTokens, promptTokens, usagePercent } from "../src/context"

const tokens = { input: 100, output: 40, reasoning: 10, cache: { read: 800, write: 50 } }

describe("context usage", () => {
  test("the prompt counts cached tokens, and occupancy adds the response", () => {
    expect(promptTokens(tokens)).toBe(950)
    expect(contextTokens(tokens)).toBe(1000)
  })

  test("a percentage needs a published limit", () => {
    expect(usagePercent(1000, 8000)).toBe(13)
    expect(usagePercent(1000, undefined)).toBeNull()
    expect(usagePercent(1000, 0)).toBeNull()
  })
})
