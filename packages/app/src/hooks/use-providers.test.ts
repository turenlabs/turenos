import { describe, expect, test } from "bun:test"
import { isRemovedProvider, popularProviders } from "./provider-visibility"

describe("provider visibility", () => {
  test("offers OpenCode Go alongside every other catalog provider", () => {
    expect(isRemovedProvider("opencode-go")).toBe(false)
    expect(isRemovedProvider("openai")).toBe(false)
  })

  test("withholds retired OpenCode Zen from every list", () => {
    expect(isRemovedProvider("opencode")).toBe(true)
    expect(popularProviders).not.toContain("opencode")
    expect(popularProviders).toContain("claude-code")
  })
})
