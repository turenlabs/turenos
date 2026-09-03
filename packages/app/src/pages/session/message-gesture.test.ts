import { describe, expect, test } from "bun:test"
import {
  FOLLOW_SCROLL_END_THRESHOLD,
  followScrollEndThreshold,
  normalizeWheelDelta,
  shouldMarkBoundaryGesture,
} from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("converts line mode to px", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 500 })).toBe(120)
  })

  test("converts page mode to container height", () => {
    expect(normalizeWheelDelta({ deltaY: -1, deltaMode: 2, rootHeight: 600 })).toBe(-600)
  })

  test("keeps pixel mode unchanged", () => {
    expect(normalizeWheelDelta({ deltaY: 16, deltaMode: 0, rootHeight: 600 })).toBe(16)
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("marks when nested scroller cannot scroll", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 300,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond top boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -40,
        scrollTop: 10,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond bottom boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 50,
        scrollTop: 580,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("does not mark when nested scroller can consume movement", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(false)
  })
})

describe("followScrollEndThreshold", () => {
  test("keeps a generous well while the view is following the bottom", () => {
    // Streaming resizes inside this well re-pin the view to the end — that is the glue
    // that makes follow feel locked while a response grows.
    expect(followScrollEndThreshold(true)).toBe(FOLLOW_SCROLL_END_THRESHOLD)
    expect(followScrollEndThreshold(true)).toBeGreaterThan(1)
  })

  test("collapses the well once the user breaks follow", () => {
    // Regression: virtual-core's resizeItem re-pins to the end on every resize while
    // within the well, with no intent guard. With a fixed 80px well, an upward wheel
    // during streaming was snapped back to distance 0 before it could escape, and the
    // landing reset the pause — locking the view to the bottom until a remount. A
    // collapsed well re-pins only at the true bottom, which is exactly the follow
    // re-engagement point.
    expect(followScrollEndThreshold(false)).toBe(1)
  })
})
