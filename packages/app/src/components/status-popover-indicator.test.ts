import { describe, expect, test } from "bun:test"
import { hasNonBlockingServiceIssue, serverStatusDotClass } from "./status-popover-indicator"

describe("serverStatusDotClass", () => {
  test("uses the success token while the server and services are healthy", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: false })).toBe("bg-icon-success-base")
  })

  test("uses the warning token for non-blocking issues while the server is online", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: true, issue: true })).toBe("bg-icon-warning-base")
  })

  test("uses the critical token only after the server connection drops", () => {
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: false })).toBe("bg-icon-critical-base")
    expect(serverStatusDotClass({ ready: true, serverHealth: false, issue: true })).toBe("bg-icon-critical-base")
  })

  test("stays neutral before status is ready", () => {
    expect(serverStatusDotClass({ ready: false, serverHealth: true, issue: false })).toBe("bg-border-weak-base")
    expect(serverStatusDotClass({ ready: false, serverHealth: undefined, issue: false })).toBe("bg-border-weak-base")
  })
})

describe("hasNonBlockingServiceIssue", () => {
  test("detects LSP failures that do not block chatting", () => {
    expect(hasNonBlockingServiceIssue(["error"])).toBe(true)
    expect(hasNonBlockingServiceIssue(["connected"])).toBe(false)
  })
})
