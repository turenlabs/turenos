import { describe, expect, test } from "bun:test"

import { withTeardownTimeout } from "./teardown-timeout"

describe("withTeardownTimeout", () => {
  test("gives up on a step that never settles, so teardown can continue", async () => {
    const warnings: string[] = []
    // The wedged sidecar: an HTTP round-trip that never resolves.
    const step = withTeardownTimeout("drainPersistence", () => new Promise<void>(() => {}), {
      warn: (message) => warnings.push(message),
      timeoutMs: 20,
    })
    await expect(step()).resolves.toBeUndefined()
    expect(warnings).toEqual(["drainPersistence did not finish before quitting; continuing shutdown without it"])
  })

  test("a step that finishes in time resolves without warning", async () => {
    const warnings: string[] = []
    const step = withTeardownTimeout("flushWindowState", () => Promise.resolve(), {
      warn: (message) => warnings.push(message),
      timeoutMs: 20,
    })
    await expect(step()).resolves.toBeUndefined()
    expect(warnings).toEqual([])
  })

  test("a real failure still propagates and still aborts the quit", async () => {
    const failure = new Error("storage refused the write")
    const step = withTeardownTimeout("drainPersistence", () => Promise.reject(failure), {
      warn: () => {},
      timeoutMs: 20,
    })
    await expect(step()).rejects.toBe(failure)
  })

  test("a failure arriving after the timeout is logged, not thrown at nobody", async () => {
    const warnings: string[] = []
    const step = withTeardownTimeout(
      "drainPersistence",
      () => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("too late")), 40)),
      { warn: (message) => warnings.push(message), timeoutMs: 10 },
    )
    await expect(step()).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(warnings).toEqual([
      "drainPersistence did not finish before quitting; continuing shutdown without it",
      "drainPersistence failed after already timing out during shutdown",
    ])
  })

  test("the whole shutdown chain still completes when one step is wedged", async () => {
    const order: string[] = []
    const flush = withTeardownTimeout("flushWindowState", () => new Promise<void>(() => {}), {
      warn: () => order.push("flush:timeout"),
      timeoutMs: 20,
    })
    await flush()
    order.push("stopSidecars")
    expect(order).toEqual(["flush:timeout", "stopSidecars"])
  })
})
