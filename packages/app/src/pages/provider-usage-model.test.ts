import { describe, expect, test } from "bun:test"
import { effectiveWorkspaceTab } from "./provider-usage-model"

describe("effectiveWorkspaceTab", () => {
  test("falls back to provider limits when Automations is disabled", () => {
    expect(effectiveWorkspaceTab(false, "automations")).toBe("limits")
    expect(effectiveWorkspaceTab(false, "limits")).toBe("limits")
  })

  test("keeps the selected tab when Automations is enabled", () => {
    expect(effectiveWorkspaceTab(true, "automations")).toBe("automations")
    expect(effectiveWorkspaceTab(true, "limits")).toBe("limits")
  })
})
