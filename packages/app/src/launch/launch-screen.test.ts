import { describe, expect, test } from "bun:test"
import { forgeShouldAnimate } from "./launch-screen"

const active = {
  static: true,
  reduced: false,
  visible: true,
  intersecting: true,
  focused: true,
  idleMs: 0,
  idleLimitMs: 3000,
}

describe("forgeShouldAnimate", () => {
  test("animates the inline logo while visible, on screen, focused and recently active", () => {
    expect(forgeShouldAnimate(active)).toBe(true)
    expect(forgeShouldAnimate({ ...active, idleMs: 2999 })).toBe(true)
  })

  test("pauses the inline logo when hidden, off-screen, blurred or idle", () => {
    expect(forgeShouldAnimate({ ...active, visible: false })).toBe(false)
    expect(forgeShouldAnimate({ ...active, intersecting: false })).toBe(false)
    expect(forgeShouldAnimate({ ...active, focused: false })).toBe(false)
    expect(forgeShouldAnimate({ ...active, idleMs: 3000 })).toBe(false)
  })

  test("never animates the inline logo under reduced motion", () => {
    expect(forgeShouldAnimate({ ...active, reduced: true })).toBe(false)
  })

  test("never pauses the boot splash", () => {
    expect(
      forgeShouldAnimate({
        ...active,
        static: false,
        visible: false,
        intersecting: false,
        focused: false,
        idleMs: 60_000,
      }),
    ).toBe(true)
    expect(forgeShouldAnimate({ ...active, static: false, reduced: true })).toBe(true)
  })
})
