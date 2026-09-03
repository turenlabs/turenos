import { describe, expect, test } from "bun:test"
import { formatLoadingDuration, getDestinationLoadingModel } from "./destination-loading-model"

describe("destination loading model", () => {
  test("keeps initial loading subtle", () => {
    expect(
      getDestinationLoadingModel({
        detail: "subtle",
        label: "Loading session",
        phase: "Fetching messages",
        elapsedMs: 65_000,
      }),
    ).toEqual({
      visibleLabel: "Loading session",
      elapsed: undefined,
      announcement: "Loading session",
    })
  })

  test("reveals a named phase before revealing elapsed time", () => {
    expect(
      getDestinationLoadingModel({
        detail: "phase",
        label: "Loading session",
        phase: "Fetching messages",
        elapsedMs: 65_000,
      }),
    ).toEqual({
      visibleLabel: "Fetching messages",
      elapsed: undefined,
      announcement: "Loading session: Fetching messages",
    })
  })

  test("adds a compact elapsed duration at the final detail level", () => {
    expect(
      getDestinationLoadingModel({
        detail: "elapsed",
        label: "Loading session",
        phase: "Fetching messages",
        elapsedMs: 65_000,
      }),
    ).toEqual({
      visibleLabel: "Fetching messages",
      elapsed: "1m 05s",
      announcement: "Loading session: Fetching messages",
    })
  })

  test("falls back to the loading label when a phase is blank", () => {
    expect(getDestinationLoadingModel({ detail: "phase", label: "Loading tab", phase: "  " })).toEqual({
      visibleLabel: "Loading tab",
      elapsed: undefined,
      announcement: "Loading tab",
    })
  })
})

describe("formatLoadingDuration", () => {
  test.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [3_659_999, "1h 00m"],
    [7_440_000, "2h 04m"],
    [-1_000, "0s"],
    [Number.NaN, "0s"],
  ])("formats %p milliseconds as %s", (elapsedMs, expected) => {
    expect(formatLoadingDuration(elapsedMs)).toBe(expected)
  })
})
