import { describe, expect, test } from "bun:test"
import { parseAutomationCommand, parseLoopCommand } from "./loop-command"

describe("parseLoopCommand", () => {
  test("parses /loop with interval and prompt", () => {
    expect(parseLoopCommand("/loop 60s find bugs")).toEqual({
      type: "loop",
      value: { prompt: "find bugs", intervalSeconds: 60 },
    })
    expect(parseLoopCommand("/loop 5m run tests")).toEqual({
      type: "loop",
      value: { prompt: "run tests", intervalSeconds: 300 },
    })
    expect(parseLoopCommand("/loop 1h optimize perf")).toEqual({
      type: "loop",
      value: { prompt: "optimize perf", intervalSeconds: 3_600 },
    })
  })

  test("rejects invalid /loop syntax", () => {
    expect(parseLoopCommand("/loop 59s nope")).toEqual({
      type: "invalid",
      message: "Loop intervals must be at least 60 seconds",
    })
    expect(parseLoopCommand("/loop 5 find bugs").type).toBe("invalid")
    expect(parseLoopCommand("/loop 5m").type).toBe("invalid")
    expect(parseLoopCommand("explain /loop 5m").type).toBe("none")
  })
})

describe("parseAutomationCommand", () => {
  test("parses each supported unit deterministically", () => {
    expect(parseAutomationCommand("/automation 60s check status")).toEqual({
      type: "automation",
      value: { name: "check status", intervalSeconds: 60, prompt: "check status" },
    })
    expect(parseAutomationCommand("/automation 2m check status")).toEqual({
      type: "automation",
      value: { name: "check status", intervalSeconds: 120, prompt: "check status" },
    })
    expect(parseAutomationCommand("/automation 3h check status")).toEqual({
      type: "automation",
      value: { name: "check status", intervalSeconds: 10_800, prompt: "check status" },
    })
    expect(parseAutomationCommand("/automation 1d check status")).toEqual({
      type: "automation",
      value: { name: "check status", intervalSeconds: 86_400, prompt: "check status" },
    })
  })

  test("rejects ambiguous syntax and sub-minute intervals", () => {
    expect(parseAutomationCommand("/automation 59s nope")).toEqual({
      type: "invalid",
      message: "Automation intervals must be at least 60 seconds",
    })
    expect(parseAutomationCommand("/automation 1.5h nope").type).toBe("invalid")
    expect(parseAutomationCommand("/automation 1M nope").type).toBe("invalid")
    expect(parseAutomationCommand("/automation 1h").type).toBe("invalid")
    expect(parseAutomationCommand("explain /automation 1h").type).toBe("none")
  })
})
