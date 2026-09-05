import { describe, expect, test } from "bun:test"
import { toggleLabelKey } from "./toggle-label"

describe("toggleLabelKey", () => {
  test("reflects the actual switch state", () => {
    expect(toggleLabelKey(true)).toBe("settings.toggle.enabled")
    expect(toggleLabelKey(false)).toBe("settings.toggle.disabled")
    expect(toggleLabelKey(undefined)).toBe("settings.toggle.disabled")
  })
})
