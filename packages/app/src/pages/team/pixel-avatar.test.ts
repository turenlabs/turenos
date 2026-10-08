import { describe, expect, test } from "bun:test"
import {
  generatePixelAvatar,
  paintPixelAvatar,
  pixelAvatarNavigation,
  pixelAvatarPalette,
  resolvePixelAvatar,
} from "./pixel-avatar"

describe("pixel avatar", () => {
  test("generates deterministic, symmetric eight-row patterns", () => {
    for (const seed of ["", "moss", "iris", "你好", "moss:pattern:1"]) {
      const avatar = generatePixelAvatar(seed)
      expect(avatar).toEqual(generatePixelAvatar(seed))
      expect(avatar).toHaveLength(8)
      expect(avatar.some((row) => /[0-7]/.test(row))).toBe(true)
      for (const row of avatar) {
        expect(row).toMatch(/^[.0-7]{8}$/)
        expect(row).toBe([...row].toReversed().join(""))
      }
    }
    expect(generatePixelAvatar("moss")).not.toEqual(generatePixelAvatar("iris"))
    expect(generatePixelAvatar("moss:pattern:1")).not.toEqual(generatePixelAvatar("moss:pattern:2"))
  })

  test("preserves valid rows, including transparent pixels and every palette index", () => {
    const avatar = Array.from({ length: 8 }, () => "01234567")
    expect(resolvePixelAvatar(avatar, "moss")).toEqual(avatar)
    expect(resolvePixelAvatar(avatar, "moss")).not.toBe(avatar)
    expect(resolvePixelAvatar(Array(8).fill("........"), "moss")).toEqual(Array(8).fill("........"))
    expect(pixelAvatarPalette).toEqual([
      "#e5e5e5", "#52525b", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c",
    ])
  })

  test("uses the actual fallback for missing or invalid rows", () => {
    const fallback = generatePixelAvatar("moss")
    for (const avatar of [
      undefined,
      [],
      new Array<string>(8),
      Array(7).fill("........"),
      Array(8).fill("......."),
      Array(8).fill("01234568"),
      Array(8).fill("<svg /> "),
    ]) {
      expect(resolvePixelAvatar(avatar, "moss")).toEqual(fallback)
    }
  })

  test("paints one cell without changing the input and supports transparency", () => {
    const avatar = Array(8).fill("........") as string[]
    const painted = paintPixelAvatar(avatar, 63, "7")
    expect(painted[7]).toBe(".......7")
    expect(painted.slice(0, 7)).toEqual(avatar.slice(0, 7))
    expect(avatar[7]).toBe("........")
    expect(paintPixelAvatar(painted, 63, ".")).toEqual(avatar)
    expect(paintPixelAvatar(avatar, -1, "2")).toEqual(avatar)
  })

  test("moves keyboard focus within grid edges without wrapping rows", () => {
    expect(pixelAvatarNavigation(0, "ArrowLeft")).toBe(0)
    expect(pixelAvatarNavigation(7, "ArrowRight")).toBe(7)
    expect(pixelAvatarNavigation(0, "ArrowUp")).toBe(0)
    expect(pixelAvatarNavigation(63, "ArrowDown")).toBe(63)
    expect(pixelAvatarNavigation(9, "ArrowUp")).toBe(1)
    expect(pixelAvatarNavigation(9, "ArrowDown")).toBe(17)
    expect(pixelAvatarNavigation(9, "Home")).toBe(8)
    expect(pixelAvatarNavigation(9, "End")).toBe(15)
    expect(pixelAvatarNavigation(9, " ")).toBeUndefined()
  })
})
