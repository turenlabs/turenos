import { describe, expect, test } from "bun:test"
import { streamEnd } from "./text-stream"

describe("stream display pacing", () => {
  test("ordinary deltas fit in one frame", () => {
    expect(streamEnd("hello world", 0, 0)).toBe(11)
  })

  test("medium bursts progress without hiding text longer than 120ms", () => {
    const text = "word ".repeat(600)
    const first = streamEnd(text, 0, 16)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(text.length)
    expect(text[first - 1]).toBe(" ")
    expect(streamEnd(text, first, 120)).toBe(text.length)
  })

  test("large bursts and background-tab catch-up drain immediately", () => {
    const large = "code\n".repeat(20_000)
    expect(streamEnd(large, 0, 16)).toBe(large.length)
    expect(streamEnd("x".repeat(3_000), 10, 5_000)).toBe(3_000)
  })

  test("never splits surrogate pairs while pacing", () => {
    const text = "x".repeat(255) + "🦊" + "y".repeat(800)
    expect(streamEnd(text, 0, 16)).toBe(257)
    expect(text.slice(0, streamEnd(text, 0, 16))).toEndWith("🦊")
  })
})
