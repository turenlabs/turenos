import { describe, expect, test } from "bun:test"
import { THINKING_LABELS, ariaHidden, thinkingStyle } from "./thinking-engine/contract"
import { resolvePreset, STATE_TO_MODE, type ThinkingState } from "./thinking-engine/presets"
import { MODE_DRAWS } from "./thinking-engine/registry"
import { createFrameScheduler } from "./thinking-engine/runtime"

const states = ["working", "searching", "solving", "listening", "composing", "shaping"] as const

describe("Thinking presets", () => {
  test("maps all public states to distinct engine modes at both tuned sizes", () => {
    expect(states.map((state) => STATE_TO_MODE[state])).toEqual(["orbits", "globe", "rubik", "wave", "ribbon", "morph"])

    states.forEach((state) => {
      ;[20, 64].forEach((size) => {
        const preset = resolvePreset(state, size as 20 | 64)
        expect(preset.mode).toBe(STATE_TO_MODE[state])
        expect(preset.speed).toBeGreaterThan(0)
        expect(preset.opts.rMin).toBeGreaterThan(0)
        expect(resolvePreset(state, size as 20 | 64)).toBe(preset)
      })
    })
  })

  test("draws a finite deterministic frame for every state and size", () => {
    states.forEach((state) => {
      ;[20, 64].forEach((size) => {
        const first = render(state, size as 20 | 64, false)
        const second = render(state, size as 20 | 64, false)
        expect(first.arcs.length).toBeGreaterThan(5)
        expect(first.arcs).toEqual(second.arcs)
        expect(first.fills).toEqual(second.fills)
        expect(first.arcs.flat().every(Number.isFinite)).toBe(true)
      })
    })
  })

  test("mirrors ink for light and dark surfaces", () => {
    const light = render("working", 20, false)
    const dark = render("working", 20, true)
    expect(light.fills[0]).not.toBe(dark.fills[0])
  })
})

describe("Thinking contract", () => {
  test("ships a fallback accessible label for every state", () => {
    states.forEach((state) => expect(THINKING_LABELS[state]).toMatch(/…$/))
  })

  test("recognizes boolean and string aria-hidden values", () => {
    expect(ariaHidden(true)).toBe(true)
    expect(ariaHidden("true")).toBe(true)
    expect(ariaHidden(false)).toBe(false)
    expect(ariaHidden("false")).toBe(false)
  })

  test("uses tuned dimensions while allowing caller style overrides", () => {
    expect(thinkingStyle(undefined, 20)).toBe("display:block;width:20px;height:20px")
    expect(thinkingStyle({ color: "red" }, 64)).toEqual({
      display: "block",
      width: "64px",
      height: "64px",
      color: "red",
    })
    expect(thinkingStyle("width:16px", 20)).toBe("display:block;width:20px;height:20px;width:16px")
  })
})

describe("Thinking frame scheduler", () => {
  test("shares one animation frame and stops after the last subscriber leaves", () => {
    const scheduled = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    const calls: string[] = []
    const next = { value: 0 }
    const scheduler = createFrameScheduler(
      (callback) => {
        next.value += 1
        scheduled.set(next.value, callback)
        return next.value
      },
      (id) => {
        cancelled.push(id)
        scheduled.delete(id)
      },
    )
    const removeFirst = scheduler.subscribe((time) => calls.push(`first:${time}`))
    const removeSecond = scheduler.subscribe((time) => calls.push(`second:${time}`))

    expect(scheduled.size).toBe(1)
    const firstFrame = scheduled.get(1)
    scheduled.delete(1)
    firstFrame?.(250)
    expect(calls).toEqual(["first:250", "second:250"])
    expect(scheduled.size).toBe(1)

    removeFirst()
    removeSecond()
    expect(cancelled).toEqual([2])
    expect(scheduled.has(2)).toBe(false)
  })
})

function render(state: ThinkingState, size: 20 | 64, dark: boolean) {
  const arcs: number[][] = []
  const fills: string[] = []
  const paint = { value: "" }
  const context = {
    get fillStyle() {
      return paint.value
    },
    set fillStyle(value: string) {
      paint.value = value
    },
    beginPath() {},
    arc(...values: number[]) {
      arcs.push(values)
    },
    fill() {
      fills.push(paint.value)
    },
  } as unknown as CanvasRenderingContext2D
  const preset = resolvePreset(state, size)
  MODE_DRAWS[preset.mode](context, size, 0.6, dark, preset.opts)
  return { arcs, fills }
}
