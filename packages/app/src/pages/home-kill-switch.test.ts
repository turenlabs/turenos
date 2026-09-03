import { describe, expect, test } from "bun:test"
import { killRunningAgents, KillSwitchError, type KillSwitchSessionClient } from "./home-kill-switch"
import { lobbyAgentKillSignal } from "./lobby-agent-controller"

function client(interrupted: number, failed = 0) {
  const signals: AbortSignal[] = []
  const session: KillSwitchSessionClient = {
    interruptAll: async (options) => {
      if (options?.signal) signals.push(options.signal)
      return { data: { data: { interrupted, failed } } }
    },
  }
  return { session, signals }
}

describe("killRunningAgents", () => {
  test("interrupts every server and sums the settled root cascades", async () => {
    const first = client(2)
    const second = client(1)

    expect(await killRunningAgents([first.session, second.session])).toBe(3)
    expect(first.signals).toHaveLength(1)
    expect(second.signals).toHaveLength(1)
  })

  test("fences lobby publication before waiting for server interruption", async () => {
    const observed: number[] = []
    const unsubscribe = lobbyAgentKillSignal.subscribe(() => observed.push(lobbyAgentKillSignal.generation()))

    await killRunningAgents([])
    unsubscribe()

    expect(observed).toHaveLength(1)
  })

  test("waits for every server and reports partial completion", async () => {
    let secondSettled = false
    const failed: KillSwitchSessionClient = {
      interruptAll: async () => {
        throw new Error("offline")
      },
    }
    const delayed: KillSwitchSessionClient = {
      interruptAll: async () => {
        await Bun.sleep(5)
        secondSettled = true
        return { data: { data: { interrupted: 2, failed: 0 } } }
      },
    }

    const error = await killRunningAgents([failed, delayed]).catch((error) => error)

    expect(secondSettled).toBe(true)
    expect(error).toBeInstanceOf(KillSwitchError)
    expect(error).toMatchObject({ interrupted: 2, failedServers: 1, failedRoots: 0 })
  })

  test("preserves partial root failures returned by one server", async () => {
    const error = await killRunningAgents([client(2, 1).session]).catch((error) => error)

    expect(error).toBeInstanceOf(KillSwitchError)
    expect(error).toMatchObject({ interrupted: 2, failedServers: 0, failedRoots: 1 })
  })
})
