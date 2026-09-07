import { describe, expect, test } from "bun:test"
import {
  buildTriggerInput,
  formatInterval,
  parseDebounceMs,
  parseEventPaths,
  parseInterval,
  triggerFromAutomation,
  validateCronExpression,
  validateDebounceMs,
  validateGlobPattern,
  validateTimezone,
  type TriggerDraft,
} from "./trigger"

const draft = (input: Partial<TriggerDraft>): TriggerDraft => ({
  kind: "interval",
  interval: "1h",
  cronExpression: "",
  timezone: "UTC",
  eventPaths: "",
  debounceMs: "",
  sessionOutcomes: "both",
  sessionID: "",
  eventAgent: "",
  ...input,
})

describe("formatInterval / parseInterval", () => {
  test("formats seconds with the largest whole unit", () => {
    expect(formatInterval(3_600)).toBe("1h")
    expect(formatInterval(86_400)).toBe("1d")
    expect(formatInterval(120)).toBe("2m")
    expect(formatInterval(90)).toBe("90s")
  })

  test("round-trips through parseInterval", () => {
    for (const seconds of [60, 300, 3_600, 86_400]) expect(parseInterval(formatInterval(seconds))).toBe(seconds)
  })

  test("rejects blank, zero-led, unitless, and unknown-unit intervals", () => {
    for (const value of ["", "0h", "01h", "1x", "h", "1.5h", "-5m", "60"]) expect(parseInterval(value)).toBeUndefined()
  })
})

describe("validateCronExpression", () => {
  test("accepts a five-field expression", () => {
    expect(validateCronExpression("*/5 * * * *")).toBeUndefined()
  })

  test("rejects blank and over-long expressions like core", () => {
    expect(validateCronExpression("   ")).toMatch(/five fields/)
    expect(validateCronExpression(`*/5 * * * ${"x".repeat(120)}`)).toMatch(/five fields/)
  })

  test("rejects four- and six-field expressions", () => {
    expect(validateCronExpression("* * * *")).toMatch(/five fields/)
    expect(validateCronExpression("* * * * * *")).toMatch(/five fields/)
  })

  test("leaves per-field ranges to the server", () => {
    expect(validateCronExpression("99 99 99 99 99")).toBeUndefined()
  })
})

describe("validateTimezone", () => {
  test("requires a non-blank IANA name like core", () => {
    expect(validateTimezone("   ")).toMatch(/required/)
    expect(validateTimezone("Mars/Olympus")).toMatch(/Unsupported timezone/)
    expect(validateTimezone("UTC")).toBeUndefined()
    expect(validateTimezone("America/New_York")).toBeUndefined()
  })
})

describe("validateGlobPattern", () => {
  test("accepts relative globs like core", () => {
    expect(validateGlobPattern("src/**/*.ts")).toBeUndefined()
    expect(validateGlobPattern("tests/**/*.ts")).toBeUndefined()
  })

  test("rejects absolute, drive-letter, and backslash patterns like core", () => {
    expect(validateGlobPattern("/etc/passwd")).toMatch(/relative/)
    expect(validateGlobPattern("C:/repo/**")).toMatch(/relative/)
    expect(validateGlobPattern("src\\**")).toMatch(/relative/)
  })

  test("rejects escaping, blank, over-long, and out-of-charset patterns like core", () => {
    expect(validateGlobPattern("../secret")).toMatch(/escape/)
    expect(validateGlobPattern("a/../b")).toMatch(/escape/)
    expect(validateGlobPattern("   ")).toMatch(/Unsupported/)
    expect(validateGlobPattern(`${"a".repeat(257)}`)).toMatch(/Unsupported/)
    expect(validateGlobPattern("foo bar.ts")).toMatch(/Unsupported/)
  })
})

describe("parseEventPaths", () => {
  test("splits lines, trims, and drops blanks", () => {
    expect(parseEventPaths("src/**/*.ts\n  \ntests/**/*.ts\n")).toEqual(["src/**/*.ts", "tests/**/*.ts"])
    expect(parseEventPaths("   ")).toEqual([])
  })
})

describe("validateDebounceMs / parseDebounceMs", () => {
  test("treats blank as omitted", () => {
    expect(validateDebounceMs("  ")).toBeUndefined()
    expect(parseDebounceMs("  ")).toBeUndefined()
  })

  test("accepts the core 0–60000 ms bounds", () => {
    expect(validateDebounceMs("0")).toBeUndefined()
    expect(validateDebounceMs("60000")).toBeUndefined()
    expect(parseDebounceMs("1000")).toBe(1_000)
  })

  test("rejects non-integers and out-of-range values like core", () => {
    for (const value of ["abc", "-1", "1.5", "60001"]) expect(validateDebounceMs(value)).toMatch(/0 and 60000/)
  })
})

describe("buildTriggerInput", () => {
  test("maps an interval draft to exactly one trigger field", () => {
    const result = buildTriggerInput(draft({}))
    expect(result.error).toBeUndefined()
    expect(result.input).toEqual({ intervalSeconds: 3_600, timezone: "UTC" })
    expect(result.input && "cronExpression" in result.input).toBe(false)
    expect(result.input && "eventTrigger" in result.input).toBe(false)
  })

  test("rejects intervals below the 60-second core minimum", () => {
    expect(buildTriggerInput(draft({ interval: "30s" })).error).toMatch(/at least 60 seconds/)
    expect(buildTriggerInput(draft({ interval: "nope" })).error).toMatch(/at least 60 seconds/)
  })

  test("maps a cron draft to exactly one trigger field", () => {
    const result = buildTriggerInput(draft({ kind: "cron", cronExpression: "  */5 * * * *  " }))
    expect(result.error).toBeUndefined()
    expect(result.input).toEqual({ cronExpression: "*/5 * * * *", timezone: "UTC" })
    expect(result.input && "intervalSeconds" in result.input).toBe(false)
    expect(buildTriggerInput(draft({ kind: "cron", cronExpression: "" })).error).toMatch(/five fields/)
  })

  test("maps a file-change draft to an event trigger", () => {
    const result = buildTriggerInput(
      draft({ kind: "file-change", eventPaths: "src/**/*.ts\ntests/**/*.ts", debounceMs: "1000" }),
    )
    expect(result.error).toBeUndefined()
    expect(result.input).toEqual({
      timezone: "UTC",
      eventTrigger: { type: "file-change", paths: ["src/**/*.ts", "tests/**/*.ts"], debounceMs: 1_000 },
    })
  })

  test("omits a blank debounce and enforces the core path rules", () => {
    const blank = buildTriggerInput(draft({ kind: "file-change", eventPaths: "src/**/*.ts", debounceMs: "  " }))
    expect(blank.input?.eventTrigger).toEqual({ type: "file-change", paths: ["src/**/*.ts"] })
    expect(buildTriggerInput(draft({ kind: "file-change", eventPaths: "" })).error).toMatch(/1 and 20/)
    expect(
      buildTriggerInput(draft({ kind: "file-change", eventPaths: Array.from({ length: 21 }, (_, i) => `a${i}/**`).join("\n") }))
        .error,
    ).toMatch(/1 and 20/)
    expect(buildTriggerInput(draft({ kind: "file-change", eventPaths: "/etc/passwd" })).error).toMatch(/relative/)
    expect(buildTriggerInput(draft({ kind: "file-change", eventPaths: "src/**/*.ts", debounceMs: "99999" })).error).toMatch(
      /0 and 60000/,
    )
  })

  test("maps a session-end draft, omitting the default outcome", () => {
    const both = buildTriggerInput(draft({ kind: "session-end" }))
    expect(both.input).toEqual({ timezone: "UTC", eventTrigger: { type: "session-end" } })
    const filtered = buildTriggerInput(
      draft({ kind: "session-end", sessionOutcomes: "failure", sessionID: " ses_1 ", eventAgent: " agent " }),
    )
    expect(filtered.input).toEqual({
      timezone: "UTC",
      eventTrigger: { type: "session-end", outcomes: ["failure"], sessionID: "ses_1", agent: "agent" },
    })
  })

  test("rejects an invalid timezone before any trigger field", () => {
    expect(buildTriggerInput(draft({ timezone: "Mars/Olympus" })).error).toMatch(/Unsupported timezone/)
    expect(buildTriggerInput(draft({ kind: "cron", cronExpression: "*/5 * * * *", timezone: "" })).error).toMatch(
      /timezone is required/,
    )
  })
})

describe("triggerFromAutomation", () => {
  test("restores an interval schedule", () => {
    expect(
      triggerFromAutomation({ schedule: { type: "interval", seconds: 3_600, timezone: "UTC" } }),
    ).toMatchObject({ kind: "interval", interval: "1h", timezone: "UTC" })
  })

  test("restores a cron schedule", () => {
    expect(
      triggerFromAutomation({
        schedule: { type: "cron", seconds: 0, expression: "*/5 * * * *", timezone: "America/New_York" },
      }),
    ).toMatchObject({ kind: "cron", cronExpression: "*/5 * * * *", timezone: "America/New_York" })
  })

  test("prefers a file-change trigger over the schedule placeholder", () => {
    expect(
      triggerFromAutomation({
        schedule: { type: "interval", seconds: 3_600, timezone: "UTC" },
        eventTrigger: { type: "file-change", paths: ["src/**/*.ts"], debounceMs: 500 },
      }),
    ).toMatchObject({
      kind: "file-change",
      eventPaths: "src/**/*.ts",
      debounceMs: "500",
      timezone: "UTC",
    })
  })

  test("restores session-end filters, defaulting to both outcomes", () => {
    expect(
      triggerFromAutomation({
        schedule: { type: "interval", seconds: 3_600, timezone: "UTC" },
        eventTrigger: { type: "session-end", outcomes: ["success"], sessionID: "ses_1", agent: "agent" },
      }),
    ).toMatchObject({ kind: "session-end", sessionOutcomes: "success", sessionID: "ses_1", eventAgent: "agent" })
    expect(
      triggerFromAutomation({
        schedule: { type: "interval", seconds: 3_600, timezone: "UTC" },
        eventTrigger: { type: "session-end" },
      }).sessionOutcomes,
    ).toBe("both")
  })
})
