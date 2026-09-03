import { describe, expect, test } from "bun:test"
import { performanceDiagnosticsDefault } from "@/context/settings"
import { shouldShowDebugBar } from "./debug-bar-visibility"

describe("performance diagnostics visibility", () => {
  test("defaults to hidden", () => {
    expect(performanceDiagnosticsDefault).toBe(false)
  })

  test("requires an enabled preference", () => {
    expect(shouldShowDebugBar(true, { disabled: false })).toBe(true)
    expect(shouldShowDebugBar(false, { disabled: false })).toBe(false)
  })

  test("honors the build-time kill switch", () => {
    expect(shouldShowDebugBar(true, { disabled: true })).toBe(false)
  })
})
