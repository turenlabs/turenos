import { describe, expect, test } from "bun:test"
import { isRemovedProvider, popularProviders } from "./provider-visibility"

describe("provider visibility", () => {
  test("offers OpenCode Go alongside every other catalog provider", () => {
    expect(isRemovedProvider("opencode-go")).toBe(false)
    expect(isRemovedProvider("openai")).toBe(false)
  })

  test("keeps OpenCode Zen available", () => {
    expect(isRemovedProvider("opencode")).toBe(false)
    expect(popularProviders).toContain("opencode")
    expect(popularProviders).toContain("claude-code")
  })
})
