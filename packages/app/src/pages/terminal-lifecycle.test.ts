import { describe, expect, test } from "bun:test"
import { takePersistedPtyRecovery, TerminalPtyGoneError } from "./terminal-lifecycle"

describe("terminal lifecycle", () => {
  test("recovers a restored PTY once only after a confirmed missing response", () => {
    const restored = new Set(["active"])
    expect(takePersistedPtyRecovery(restored, "active", new TypeError("fetch failed"))).toBe(false)
    expect(takePersistedPtyRecovery(restored, "active", new TerminalPtyGoneError(new Error("gone")))).toBe(true)
    expect(takePersistedPtyRecovery(restored, "active", new TerminalPtyGoneError(new Error("gone")))).toBe(false)
  })
})
