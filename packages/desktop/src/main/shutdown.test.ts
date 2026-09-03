import { describe, expect, test } from "bun:test"
import { createShutdownCoordinator } from "./shutdown"

describe("desktop shutdown", () => {
  test("blocks normal quit until window state and Storage queues drain before sidecars stop", async () => {
    const order: string[] = []
    const windowState = Promise.withResolvers<void>()
    const persistence = Promise.withResolvers<void>()
    const sidecars = Promise.withResolvers<void>()
    const shutdown = createShutdownCoordinator({
      flushWindowState: async () => {
        order.push("flush:start")
        await windowState.promise
        order.push("flush:done")
      },
      drainPersistence: async () => {
        order.push("drain:start")
        await persistence.promise
        order.push("drain:done")
      },
      stopSidecars: async () => {
        order.push("sidecars:start")
        await sidecars.promise
        order.push("sidecars:done")
      },
      stopWslServers: () => order.push("wsl:stop"),
      setAppQuitting: () => order.push("quitting"),
      quit: () => order.push("quit"),
      failed: () => order.push("failed"),
    })
    const event = { preventDefault: () => order.push("prevent") }

    shutdown.beforeQuit(event)
    await Promise.resolve()
    expect(order).toEqual(["quitting", "prevent", "flush:start"])
    windowState.resolve()
    await Bun.sleep(0)
    expect(order).toEqual(["quitting", "prevent", "flush:start", "flush:done", "drain:start"])
    persistence.resolve()
    await Bun.sleep(0)
    expect(order).toEqual([
      "quitting",
      "prevent",
      "flush:start",
      "flush:done",
      "drain:start",
      "drain:done",
      "sidecars:start",
    ])
    sidecars.resolve()
    await shutdown.stop()
    await Promise.resolve()
    expect(order).toEqual([
      "quitting",
      "prevent",
      "flush:start",
      "flush:done",
      "drain:start",
      "drain:done",
      "sidecars:start",
      "sidecars:done",
      "wsl:stop",
      "quit",
    ])

    shutdown.beforeQuit(event)
    expect(order.at(-1)).toBe("quitting")
  })
})

test("a failing teardown step still completes the quit", async () => {
  // Regression: the steps ran as one await chain whose rejection reached
  // `failed`, cancelling the quit after Electron had already closed the
  // windows - a running, windowless app that could not be quit at all.
  const calls: string[] = []
  const failures: unknown[] = []
  let quit = false
  const coordinator = createShutdownCoordinator({
    flushWindowState: async () => {
      calls.push("flush")
      throw new Error("storage 400")
    },
    drainPersistence: async () => {
      calls.push("drain")
      throw new Error("task conflict")
    },
    stopSidecars: async () => {
      calls.push("sidecars")
    },
    stopWslServers: () => {
      calls.push("wsl")
    },
    setAppQuitting: () => {},
    quit: () => {
      quit = true
    },
    failed: (error) => failures.push(error),
  })

  await coordinator.stop()

  // Every later step still ran, both failures were reported, and the quit is
  // reachable - the sidecar in particular must always be stopped.
  expect(calls).toEqual(["flush", "drain", "sidecars", "wsl"])
  expect(failures).toHaveLength(2)

  coordinator.beforeQuit({ preventDefault: () => {} })
  expect(quit).toBe(false)
})
