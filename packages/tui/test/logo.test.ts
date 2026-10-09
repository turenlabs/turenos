import { expect, test } from "bun:test"
import { anvilMark, turenLogo } from "../src/logo"

const rows = (logo: { content: { chunks: { text: string }[] } }) =>
  logo.content.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")

test("the logo carries the anvil wherever a dialog has room, and never outgrows it", () => {
  const wide = turenLogo(true)
  expect([wide.width, wide.height]).toEqual([66, 9])
  // A 58-column phone leaves a dialog 52 inner columns: the small anvil and the wordmark fill them exactly.
  expect(turenLogo(false, 58).width).toBe(52)
  expect(turenLogo(false, 57).width).toBe(41)
  for (const logo of [wide, turenLogo(false, 58), turenLogo(false, 40), anvilMark()]) {
    const lines = rows(logo)
    expect(lines).toHaveLength(logo.height)
    for (const line of lines) expect(line.length).toBe(logo.width)
  }
  expect(rows(anvilMark())[0]!.trim()).not.toBe("")
})
