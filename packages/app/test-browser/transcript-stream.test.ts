import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPacedValue } from "../../session-ui/src/components/text-stream"

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

test("stream updates coalesce into a paint and completion flushes immediately", async () => {
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore({ text: "", live: true })
    const value = createPacedValue(
      () => state.text,
      () => state.live,
    )
    const paints: string[] = []
    createEffect(() => paints.push(value()))
    return { dispose, setState, value, paints }
  })
  try {
    for (let index = 1; index <= 100; index++) fixture.setState("text", "x".repeat(index))
    expect(fixture.value()).toBe("")
    await frame()
    expect(fixture.value()).toBe("x".repeat(100))
    expect(fixture.paints.length).toBe(2)
    fixture.setState("text", "x".repeat(3_000))
    expect(fixture.value().length).toBeLessThan(3_000)
    fixture.setState("live", false)
    expect(fixture.value()).toBe("x".repeat(3_000))
  } finally {
    fixture.dispose()
  }
})

test("stream replacement and disposal cannot leak stale queued text", async () => {
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore({ text: "original", live: true })
    const value = createPacedValue(
      () => state.text,
      () => state.live,
    )
    return { dispose, setState, value }
  })
  fixture.setState("text", "original" + "x".repeat(3_000))
  fixture.setState("text", "replacement")
  expect(fixture.value()).toBe("replacement")
  fixture.setState("text", "replacement" + "y".repeat(3_000))
  fixture.dispose()
  await frame()
  expect(fixture.value()).toBe("replacement")
})
