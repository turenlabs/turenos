import { describe, expect, test } from "bun:test"
import { visualizationTreemap } from "./visualization-layout"

describe("visualizationTreemap", () => {
  test("uses deterministic D3 squarified tiles instead of count splits", () => {
    const rectangles = visualizationTreemap([1, 1, 1, 1], 100, 100)
    expect(rectangles).toEqual(visualizationTreemap([1, 1, 1, 1], 100, 100))
    expect(rectangles[0]!.height).not.toBe(50)
    expect(rectangles[0]!.width * rectangles[0]!.height).toBeCloseTo(2500, 8)
  })
  test("assigns proportional areas without overlap", () => {
    const values = [1, 2, 3, 4, 5]
    const rectangles = visualizationTreemap(values, 100, 80)
    expect(rectangles).toHaveLength(values.length)
    for (const rectangle of rectangles) {
      expect(rectangle.width * rectangle.height).toBeCloseTo((8000 * values[rectangle.index]!) / 15, 6)
      expect(rectangle.x).toBeGreaterThanOrEqual(0)
      expect(rectangle.y).toBeGreaterThanOrEqual(0)
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(100)
      expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(80)
      for (const other of rectangles.filter((item) => item.index !== rectangle.index)) {
        const overlapWidth =
          Math.min(rectangle.x + rectangle.width, other.x + other.width) - Math.max(rectangle.x, other.x)
        const overlapHeight =
          Math.min(rectangle.y + rectangle.height, other.y + other.height) - Math.max(rectangle.y, other.y)
        expect(Math.max(0, overlapWidth) * Math.max(0, overlapHeight)).toBeCloseTo(0, 8)
      }
    }
  })

  test("skips zero and invalid weights and preserves input indices", () => {
    expect(visualizationTreemap([0, 2, 0], 10, 20)).toEqual([{ index: 1, x: 0, y: 0, width: 10, height: 20 }])
    expect(visualizationTreemap([0, 0])).toEqual([])
    expect(visualizationTreemap([NaN, Infinity, -1, 1e13])).toEqual([])
    expect(visualizationTreemap([1], 0, 20)).toEqual([])
    expect(visualizationTreemap([1], 20, Infinity)).toEqual([])
  })

  test("bounds the layout to 500 finite rectangles", () => {
    const rectangles = visualizationTreemap(Array.from({ length: 1000 }, (_, index) => (index % 2 ? 1e12 : 0.001)))
    expect(rectangles).toHaveLength(500)
    expect(rectangles.every((item) => Object.values(item).every(Number.isFinite))).toBe(true)
    expect(rectangles.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(800 * 360, 6)
  })
})
