import { expect, test } from "bun:test"
import { formatInterval, parseInterval, validateCronExpression } from "../src/automation-schedule"

test("intervals round-trip above a year and reject unsafe integers", () => {
  for (const seconds of [60, 90, 3600, 367 * 86400, Number.MAX_SAFE_INTEGER])
    expect(parseInterval(formatInterval(seconds))).toBe(seconds)
  for (const text of ["0s", "01h", "1.5h", "-1h", "9007199254740992s", "9007199254740991d"])
    expect(parseInterval(text)).toBeUndefined()
})

test("cron entry checks bound shape and size but leave field parsing to the server", () => {
  for (const text of ["*/05 * * * *", "*/60 * * * *", "0 9 * * MON-FRI"])
    expect(validateCronExpression(text)).toBeUndefined()
  for (const text of ["", "* * * *", "* * * * * *", `${"0".repeat(121)} * * * *`])
    expect(validateCronExpression(text)).toContain("five fields")
})
