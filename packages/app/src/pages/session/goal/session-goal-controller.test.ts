import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionGoalInfo, SessionRecoveryOutcome } from "@turenlabs/sdk/v2/client"

let createSessionGoalController: typeof import("./session-goal-controller").createSessionGoalController
let createSessionGoalHydrationGuard: typeof import("./session-goal-controller").createSessionGoalHydrationGuard
let createSessionGoalRecovery: typeof import("./session-goal-controller").createSessionGoalRecovery
let createSessionRecoveryProbe: typeof import("./session-goal-controller").createSessionRecoveryProbe
let setCalls: Array<{
  sessionID: string
  id?: string
  messageID?: string
  objective?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}>
let rejectNext = false
let release: (() => void) | undefined
let holdFirstSet = true
let getGoal: () => Promise<{ data: { data: SessionGoalInfo | null } }>
let statusGoal: (input: {
  sessionID: string
  goalID: string
  expectedRevision: number
  status: SessionGoalInfo["status"]
}) => Promise<{ data: { data: SessionGoalInfo } }>
let clearGoal: (input: { sessionID: string; goalID: string; expectedRevision: number }) => Promise<{ data?: undefined }>
let resumeSession: () => Promise<{ data: { data: SessionRecoveryOutcome } }>
let listeners: Record<string, ((event: { properties: Record<string, unknown> }) => void) | undefined>

const goal = {
  id: "goal_result",
  sessionID: "ses_goal",
  revision: 1,
  objective: "Ship safely",
  status: "active" as const,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  time: { created: 1, updated: 1, statusChanged: 1 },
}

beforeAll(async () => {
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({
      scope: "local",
      client: {
        v2: {
          session: {
            goal: {
              get: () => getGoal(),
              set: async (input: {
                sessionID: string
                sessionGoalSetPayload: Omit<(typeof setCalls)[number], "sessionID">
              }) => {
                setCalls.push({ sessionID: input.sessionID, ...input.sessionGoalSetPayload })
                if (rejectNext) {
                  rejectNext = false
                  throw new Error("connection lost")
                }
                if (setCalls.length > 1) return { data: { data: goal } }
                if (!holdFirstSet) return { data: { data: goal } }
                await new Promise<void>((resolve) => {
                  release = resolve
                })
                return { data: { data: goal } }
              },
              status: (input: {
                sessionID: string
                sessionGoalStatusPayload: Omit<Parameters<typeof statusGoal>[0], "sessionID">
              }) => statusGoal({ sessionID: input.sessionID, ...input.sessionGoalStatusPayload }),
              clear: (input: {
                sessionID: string
                sessionGoalClearPayload: Omit<Parameters<typeof clearGoal>[0], "sessionID">
              }) => clearGoal({ sessionID: input.sessionID, ...input.sessionGoalClearPayload }),
            },
            resume: () => resumeSession(),
          },
        },
      },
      event: {
        on: (name: string, listener: (event: { properties: Record<string, unknown> }) => void) => {
          listeners[name] = listener
          return () => {
            delete listeners[name]
          }
        },
      },
    }),
  }))
  mock.module("@/pages/session/session-ownership", () => ({
    createSessionOwnership: () => ({
      capture: () => ({ current: () => true }),
    }),
  }))
  const mod = await import("./session-goal-controller")
  createSessionGoalController = mod.createSessionGoalController
  createSessionGoalHydrationGuard = mod.createSessionGoalHydrationGuard
  createSessionGoalRecovery = mod.createSessionGoalRecovery
  createSessionRecoveryProbe = mod.createSessionRecoveryProbe
})

beforeEach(() => {
  goal.revision = 1
  goal.status = "active"
  goal.tokensUsed = 0
  setCalls = []
  rejectNext = false
  release = undefined
  holdFirstSet = true
  getGoal = async () => ({ data: { data: null } })
  statusGoal = async () => ({ data: { data: { ...goal, status: "paused" } } })
  clearGoal = async () => ({ data: undefined })
  resumeSession = async () => ({ data: { data: { status: "idle" } } })
  listeners = {}
})

describe("createSessionGoalController", () => {
  test("coalesces a double submit into one stable goal and one visible message identity", async () => {
    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const controller = createSessionGoalController({
          sessionID: () => undefined,
          sessionKey: () => "draft",
        })
        const first = controller.start({
          sessionID: "ses_goal",
          objective: "Ship safely",
          agent: "review",
          model: { providerID: "provider", id: "model", variant: "high" },
          client: undefined as never,
        })
        const second = controller.start({
          sessionID: "ses_goal",
          objective: "Ship safely",
          agent: "review",
          model: { providerID: "provider", id: "model", variant: "high" },
          client: undefined as never,
        })

        expect(setCalls).toHaveLength(1)
        expect(setCalls[0]?.id).toStartWith("goal_")
        expect(setCalls[0]?.messageID).toStartWith("msg_")
        expect(setCalls[0]).toMatchObject({
          agent: "review",
          model: { providerID: "provider", id: "model", variant: "high" },
        })
        release?.()
        void Promise.all([first, second]).then((values) => {
          expect(values).toEqual([goal, goal])
          dispose()
          done()
        })
      })
    })
  })

  test("reuses the same IDs when a lost response is retried", async () => {
    rejectNext = true
    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const controller = createSessionGoalController({
          sessionID: () => undefined,
          sessionKey: () => "draft",
        })
        void controller
          .start({
            sessionID: "ses_goal",
            objective: "Ship safely",
            client: undefined as never,
          })
          .catch(() =>
            controller.start({
              sessionID: "ses_goal",
              objective: "Ship safely",
              client: undefined as never,
            }),
          )
          .then(() => {
            expect(setCalls).toHaveLength(2)
            expect(setCalls[1]?.id).toBe(setCalls[0]?.id)
            expect(setCalls[1]?.messageID).toBe(setCalls[0]?.messageID)
            dispose()
            done()
          })
      })
    })
  })

  test("rejects a stale GET after live events clear and replace the goal", async () => {
    const hydration = createSessionGoalHydrationGuard()
    const request = hydration.capture("ses_goal")
    const replacement = {
      ...goal,
      id: "goal_replacement",
      objective: "Replacement",
      revision: 1,
    }
    hydration.advance("ses_goal")
    hydration.advance("ses_goal")
    const current = hydration.current("ses_goal", request) ? goal : replacement

    expect(current).toEqual(replacement)
  })

  test("rejects a stale GET after a local start or clear mutation", () => {
    const hydration = createSessionGoalHydrationGuard()
    const beforeStart = hydration.capture("ses_goal")
    hydration.advance("ses_goal")
    const beforeClear = hydration.capture("ses_goal")
    hydration.advance("ses_goal")

    expect(hydration.current("ses_goal", beforeStart)).toBeFalse()
    expect(hydration.current("ses_goal", beforeClear)).toBeFalse()
  })

  test("refreshes and retries a pause when accounting wins the first revision CAS", async () => {
    holdFirstSet = false
    const revisions: number[] = []
    const latest = { ...goal, revision: 2, tokensUsed: 12 }
    const paused = { ...latest, revision: 3, status: "paused" as const }
    getGoal = async () => ({ data: { data: latest } })
    statusGoal = async (input) => {
      revisions.push(input.expectedRevision)
      if (revisions.length === 1) throw new Error("revision conflict")
      return { data: { data: paused } }
    }

    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const controller = createSessionGoalController({
          sessionID: () => "ses_goal",
          sessionKey: () => "ses_goal",
        })
        void controller
          .start({ sessionID: "ses_goal", objective: goal.objective })
          .then(() => controller.pause("ses_goal"))
          .then((result) => {
            expect(revisions).toEqual([1, 2])
            expect(result).toEqual(paused)
            expect(controller.goal()).toEqual(paused)
            dispose()
            done()
          })
      })
    })
  })

  test("does not retry pause against a replacement goal", async () => {
    holdFirstSet = false
    const replacement = { ...goal, id: "goal_replacement", revision: 1 }
    let calls = 0
    getGoal = async () => ({ data: { data: replacement } })
    statusGoal = async () => {
      calls++
      throw new Error("revision conflict")
    }

    await new Promise<void>((done, fail) => {
      createRoot((dispose) => {
        const controller = createSessionGoalController({
          sessionID: () => "ses_goal",
          sessionKey: () => "ses_goal",
        })
        void controller
          .start({ sessionID: "ses_goal", objective: goal.objective })
          .then(() => controller.pause("ses_goal"))
          .then(() => fail(new Error("Pause unexpectedly succeeded")))
          .catch((error) => {
            try {
              expect(error).toBeInstanceOf(Error)
              expect(calls).toBe(1)
              done()
            } catch (assertion) {
              fail(assertion)
            }
          })
          .finally(() => {
            dispose()
          })
      })
    })
  })

  test("refreshes and retries clear when accounting wins the first revision CAS", async () => {
    holdFirstSet = false
    const revisions: number[] = []
    getGoal = async () => ({ data: { data: { ...goal, revision: 2, tokensUsed: 12 } } })
    clearGoal = async (input) => {
      revisions.push(input.expectedRevision)
      if (revisions.length === 1) throw new Error("revision conflict")
      return { data: undefined }
    }

    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const controller = createSessionGoalController({
          sessionID: () => "ses_goal",
          sessionKey: () => "ses_goal",
        })
        void controller
          .start({ sessionID: "ses_goal", objective: goal.objective })
          .then(() => controller.clear("ses_goal"))
          .then(() => {
            expect(revisions).toEqual([1, 2])
            expect(controller.goal()).toBeUndefined()
            dispose()
            done()
          })
      })
    })
  })

  test("probes recovery once per opened session regardless of goal state", async () => {
    const recovery = createSessionGoalRecovery()
    let calls = 0
    const resume = () => {
      calls++
      return Promise.resolve({ status: "idle" } as const)
    }
    const first = recovery.run({
      scope: "local",
      sessionID: "ses_goal",
      resume,
    })
    const duplicate = recovery.run({
      scope: "local",
      sessionID: "ses_goal",
      resume,
    })

    expect(calls).toBe(1)
    expect(first).toBe(duplicate)
    expect(await Promise.all([first, duplicate])).toEqual([{ status: "idle" }, { status: "idle" }])
  })

  test("retries transport failures with bounded backoff before completing once", async () => {
    const delays: number[] = []
    const recovery = createSessionGoalRecovery({
      attempts: 3,
      wait: async (delay) => {
        delays.push(delay)
      },
    })
    let calls = 0
    const run = () =>
      recovery.run({
        scope: "local",
        sessionID: "ses_goal",
        resume: async () => {
          calls++
          if (calls < 3) throw new Error("offline")
          return { status: "idle" }
        },
      })

    expect(await run()).toEqual({ status: "idle" })
    expect(await run()).toBeUndefined()
    expect(calls).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  test("coalesces in-flight probes and permits an explicit retry after persistent failure", async () => {
    const recovery = createSessionGoalRecovery({ attempts: 1 })
    let calls = 0
    let reject: ((error: Error) => void) | undefined
    let online = false
    const run = () =>
      recovery.run({
        scope: "local",
        sessionID: "ses_goal",
        resume: () => {
          calls++
          if (online) return Promise.resolve({ status: "idle" })
          return new Promise<SessionRecoveryOutcome>((_, rejectPromise) => {
            reject = rejectPromise
          })
        },
      })
    const first = run()
    const duplicate = run()

    expect(first).toBe(duplicate)
    expect(calls).toBe(1)
    reject?.(new Error("offline"))
    expect((await Promise.allSettled([first, duplicate])).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])

    online = true
    expect(await run()).toEqual({ status: "idle" })
    expect(calls).toBe(2)
  })

  test("recovers a no-goal session and refreshes a paused goal after interruption", async () => {
    let recoveryCalls = 0
    let goalCalls = 0
    const interrupted = {
      status: "interrupted",
      assistantMessageID: "msg_interrupted",
      reason: "Recovered an incomplete durable assistant turn.",
      next: "idle",
    } as const
    const paused = { ...goal, status: "paused" as const, revision: 2 }
    getGoal = async () => {
      goalCalls++
      return { data: { data: paused } }
    }
    resumeSession = async () => {
      recoveryCalls++
      return { data: { data: interrupted } }
    }
    const outcomes: SessionRecoveryOutcome[] = []
    const failures: unknown[] = []
    const hydrated = { goal: undefined as SessionGoalInfo | null | undefined }
    const probe = createSessionRecoveryProbe({
      recovery: createSessionGoalRecovery(),
      scope: "local",
      sessionID: "ses_goal",
      resume: () => resumeSession().then((result) => result.data.data),
      onInterrupted: async (outcome) => {
        outcomes.push(outcome)
        hydrated.goal = (await getGoal()).data.data
      },
      onFailure: (failure) => failures.push(failure.error),
    })

    await probe.run()

    expect(recoveryCalls).toBe(1)
    expect(goalCalls).toBe(1)
    expect(outcomes).toEqual([interrupted])
    expect(failures).toEqual([])
    expect(hydrated.goal).toEqual(paused)
  })

  test("forwards a shell restart interruption through the shared recovery probe", async () => {
    const interrupted = {
      status: "interrupted",
      shellMessageID: "msg_shell_interrupted",
      reason: "Shell execution was interrupted before this TurenOS process observed completion.",
      next: "scheduled",
    } as unknown as SessionRecoveryOutcome
    const outcomes: SessionRecoveryOutcome[] = []
    const probe = createSessionRecoveryProbe({
      recovery: createSessionGoalRecovery(),
      scope: "local",
      sessionID: "ses_shell_interrupted",
      resume: async () => interrupted,
      onInterrupted: (outcome) => {
        outcomes.push(outcome)
      },
      onFailure: () => undefined,
    })

    await probe.run()

    expect(outcomes).toEqual([interrupted])
  })

  test("surfaces a persistent recovery failure with a working explicit retry", async () => {
    let recoveryCalls = 0
    let online = false
    resumeSession = async () => {
      recoveryCalls++
      if (!online) throw new Error("offline")
      return { data: { data: { status: "idle" } } }
    }
    const failures: Array<{ retry: () => Promise<void> }> = []
    const probe = createSessionRecoveryProbe({
      recovery: createSessionGoalRecovery({ attempts: 1 }),
      scope: "local",
      sessionID: "ses_goal",
      resume: () => resumeSession().then((result) => result.data.data),
      onInterrupted: () => undefined,
      onFailure: (failure) => failures.push(failure),
    })

    await probe.run()
    expect(recoveryCalls).toBe(1)
    expect(failures).toHaveLength(1)

    online = true
    await failures[0]!.retry()
    expect(recoveryCalls).toBe(2)
    expect(failures).toHaveLength(1)
  })
})
