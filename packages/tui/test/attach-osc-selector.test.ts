import { expect, test } from "bun:test"
import { filterOsc } from "../src/attach/osc"
import type { OscState } from "../src/attach/types"

test("numeric OSC selectors remain blocked across every split without writing to a terminal", () => {
  for (const selector of ["052", "00", "01", "02", "0".repeat(62) + "52", "0".repeat(10000) + "52"]) {
    const input = `a\x1b]${selector};synthetic-payload\x07b`
    for (const frames of [[input], [...input], [input.slice(0, 5), input.slice(5)]]) {
      const state: OscState = { held: "", dropping: false }
      const output = frames
        .map((frame) => {
          const shown = filterOsc(state, frame)
          expect(state.held.length + (state.selector?.prefix.length ?? 0)).toBeLessThanOrEqual(66)
          return shown
        })
        .join("")
      expect(output).toBe("ab")
    }
  }
})

test("safe numeric OSCs preserve exact bytes up to the selector limit", () => {
  for (const selector of ["0007", "0008", "22", "520", "9".repeat(64)]) {
    const input = `a\x1b]${selector};safe\x1b\\b`
    const state: OscState = { held: "", dropping: false }
    expect([...input].map((frame) => filterOsc(state, frame)).join("")).toBe(input)
  }
  const state: OscState = { held: "", dropping: false }
  expect(filterOsc(state, `a\x1b]${"9".repeat(65)};safe\x07b`)).toBe("ab")
})
