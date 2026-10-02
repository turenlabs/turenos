import { expect, test } from "bun:test"
import { dailyTip, localDay, tips } from "./daily-tips"

test("formats the entry date in local calendar time", () => {
  expect(localDay(new Date(2026, 8, 29, 23, 55))).toBe("2026-09-29")
  expect(localDay(new Date(2026, 8, 30, 0, 5))).toBe("2026-09-30")
})

test("keeps the same daily tip across drafts and rotates on the next local day", () => {
  const first = dailyTip(new Date(2026, 8, 29, 8, 15))
  expect(first).toEqual(dailyTip(new Date(2026, 8, 29, 23, 55)))
  expect(first).not.toEqual(dailyTip(new Date(2026, 8, 30, 0, 5)))
})

test("keeps browse-only guidance out of the daily rotation", () => {
  const automatic = tips.filter((tip) => tip.automatic)
  expect(automatic.length).toBeGreaterThan(1)
  expect(new Set(tips.map((tip) => tip.id)).size).toBe(tips.length)
  expect(tips.some((tip) => !tip.automatic)).toBe(true)
  const start = automatic.findIndex((tip) => tip.id === dailyTip(new Date(2026, 8, 29)).id)
  expect(
    Array.from({ length: automatic.length * 2 }, (_, offset) => dailyTip(new Date(2026, 8, 29 + offset)).id),
  ).toEqual(
    Array.from({ length: automatic.length * 2 }, (_, offset) => automatic[(start + offset) % automatic.length].id),
  )
})
