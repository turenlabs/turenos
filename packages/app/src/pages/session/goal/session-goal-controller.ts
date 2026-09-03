import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionRecoveryOutcome } from "@turenlabs/sdk/v2/client"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { Identifier } from "@/utils/id"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { markSessionV2 } from "./session-v2-delta-gate"
import {
  applySessionGoalSnapshot,
  clearSessionGoalSnapshot,
  type SessionGoalInfo,
  type SessionGoalStatus,
} from "./session-goal"

type GoalSetAttempt = {
  id: string
  messageID: string
  promise?: Promise<SessionGoalInfo>
}

type SessionRecoveryInterruption = Extract<SessionRecoveryOutcome, { status: "interrupted" }>

const goalSetAttempts = new Map<string, GoalSetAttempt>()

export function createSessionGoalController(input: {
  sessionID: Accessor<string | undefined>
  sessionKey: Accessor<string>
  onInterrupted?: (outcome: SessionRecoveryInterruption) => void
  onRecoveryError?: (failure: SessionRecoveryFailure) => void
  recovery?: ReturnType<typeof createSessionGoalRecovery>
}) {
  const sdk = useSDK()
  const owner = createSessionOwnership(input.sessionKey)
  const recovery = input.recovery ?? createSessionGoalRecovery()
  const [store, setStore] = createStore({
    goals: {} as Record<string, SessionGoalInfo | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    pending: {} as Record<string, boolean | undefined>,
    mode: false,
    editRequest: 0,
  })
  let hydration = 0
  const hydrationGuard = createSessionGoalHydrationGuard()

  createEffect(() => {
    input.sessionKey()
    setStore("mode", false)
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    const client = sdk().client
    const request = ++hydration
    const events = sessionID ? hydrationGuard.capture(sessionID) : 0
    if (!sessionID) return

    setStore("loading", sessionID, true)
    const goalRequest = client.v2.session.goal
      .get({ sessionID })
      .then((result) => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        if (!hydrationGuard.current(sessionID, events)) return
        const goal = (result.data?.data ?? null) as SessionGoalInfo | null
        setStore("goals", sessionID, (current) => applySessionGoalSnapshot(current, goal ?? undefined))
      })
      .catch(() => undefined)
    const recoveryProbe = createSessionRecoveryProbe({
      recovery,
      scope: sdk().scope,
      sessionID,
      resume: () => client.v2.session.resume({ sessionID }).then((result) => result.data!.data),
      onInterrupted: (outcome) => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        hydrationGuard.advance(sessionID)
        input.onInterrupted?.(outcome)
        const recoveredEvents = hydrationGuard.capture(sessionID)
        return client.v2.session.goal.get({ sessionID }).then((result) => {
          if (request !== hydration || input.sessionID() !== sessionID) return
          if (!hydrationGuard.current(sessionID, recoveredEvents)) return
          const goal = (result.data?.data ?? null) as SessionGoalInfo | null
          setStore("goals", sessionID, (current) => applySessionGoalSnapshot(current, goal ?? undefined))
        })
      },
      onFailure: (failure) => {
        if (request !== hydration || input.sessionID() !== sessionID) return
        input.onRecoveryError?.(failure)
      },
    })
    const recoveryRequest = recoveryProbe.run()

    void Promise.all([goalRequest, recoveryRequest]).finally(() => {
      if (request !== hydration || input.sessionID() !== sessionID) return
      setStore("loading", sessionID, false)
    })
  })

  createEffect(() => {
    const current = sdk()
    const updated = current.event.on("session.next.goal.updated", (event) => {
      const sessionID = event.properties.sessionID
      hydrationGuard.advance(sessionID)
      // Admission details are deliberately ignored; only the public goal snapshot belongs in UI state.
      setStore("goals", sessionID, (goal) => applySessionGoalSnapshot(goal, event.properties.goal))
    })
    const cleared = current.event.on("session.next.goal.cleared", (event) => {
      const sessionID = event.properties.sessionID
      hydrationGuard.advance(sessionID)
      setStore("goals", sessionID, (goal) =>
        clearSessionGoalSnapshot(goal, {
          goalID: event.properties.goalID,
          revision: event.properties.revision,
        }),
      )
    })
    onCleanup(() => {
      updated()
      cleared()
    })
  })

  const run = async <T>(sessionID: string, mutation: () => Promise<T>) => {
    const captured = owner.capture()
    setStore("pending", sessionID, true)
    return mutation().finally(() => {
      if (!captured.current()) return
      setStore("pending", sessionID, false)
    })
  }

  const start = (value: {
    sessionID: string
    objective: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    client?: DirectorySDK["client"]
  }) => {
    const client = value.client ?? sdk().client
    const key = [
      sdk().scope,
      value.sessionID,
      value.objective,
      value.agent ?? "",
      value.model?.providerID ?? "",
      value.model?.id ?? "",
      value.model?.variant ?? "default",
    ].join("\0")
    const attempt = goalSetAttempts.get(key) ?? {
      id: Identifier.ascending("goal"),
      messageID: Identifier.ascending("message"),
    }
    goalSetAttempts.set(key, attempt)
    if (attempt.promise) return attempt.promise

    const promise = run(value.sessionID, () =>
      client.v2.session.goal
        .set({
          sessionID: value.sessionID,
          sessionGoalSetPayload: {
            id: attempt.id,
            messageID: attempt.messageID,
            objective: value.objective,
            agent: value.agent,
            model: value.model,
          },
        })
        .then((result) => result.data!.data),
    ).then((goal) => {
      markSessionV2(value.sessionID)
      hydrationGuard.advance(value.sessionID)
      setStore("goals", value.sessionID, (current) => applySessionGoalSnapshot(current, goal))
      goalSetAttempts.delete(key)
      setStore("mode", false)
      return goal
    })
    attempt.promise = promise
    void promise.catch(() => {
      attempt.promise = undefined
    })
    return promise
  }

  const edit = (value: {
    sessionID: string
    objective: string
    goal?: SessionGoalInfo
    client?: DirectorySDK["client"]
  }) => {
    const goal = value.goal ?? store.goals[value.sessionID]
    if (!goal) return Promise.reject(new Error("No active goal"))
    const client = value.client ?? sdk().client
    return run(value.sessionID, () =>
      client.v2.session.goal
        .edit({
          sessionID: value.sessionID,
          sessionGoalEditPayload: {
            goalID: goal.id,
            expectedRevision: goal.revision,
            objective: value.objective,
          },
        })
        .then((result) => result.data!.data),
    ).then((next) => {
      hydrationGuard.advance(value.sessionID)
      setStore("goals", value.sessionID, (current) => applySessionGoalSnapshot(current, next))
      setStore("mode", false)
      return next
    })
  }

  const status = (sessionID: string, next: SessionGoalStatus, current?: SessionGoalInfo) => {
    const goal = current ?? store.goals[sessionID]
    if (!goal) return Promise.reject(new Error("No active goal"))
    return run(sessionID, () =>
      sdk()
        .client.v2.session.goal.status({
          sessionID,
          sessionGoalStatusPayload: {
            goalID: goal.id,
            expectedRevision: goal.revision,
            status: next,
          },
        })
        .then((result) => result.data!.data),
    ).then((value) => {
      hydrationGuard.advance(sessionID)
      setStore("goals", sessionID, (current) => applySessionGoalSnapshot(current, value))
      return value
    })
  }

  const pause = (sessionID: string) => {
    const goal = store.goals[sessionID]
    if (!goal) return Promise.reject(new Error("No active goal"))
    if (goal.status === "paused") return Promise.resolve(goal)
    if (goal.status !== "active") return Promise.reject(new Error("Goal is not active"))

    return run(sessionID, async () => {
      const client = sdk().client
      const pauseCurrent = async (current: SessionGoalInfo, retries: number): Promise<SessionGoalInfo> =>
        client.v2.session.goal
          .status({
            sessionID,
            sessionGoalStatusPayload: {
              goalID: current.id,
              expectedRevision: current.revision,
              status: "paused",
            },
          })
          .then((result) => result.data!.data)
          .catch(async (error) => {
            if (retries === 0) throw error
            const response = await client.v2.session.goal.get({ sessionID })
            const latest = (response.data?.data ?? null) as SessionGoalInfo | null
            if (!latest || latest.id !== goal.id) throw error
            setStore("goals", sessionID, (value) => applySessionGoalSnapshot(value, latest))
            if (latest.status === "paused") return latest
            if (latest.status !== "active") throw error
            return pauseCurrent(latest, retries - 1)
          })
      return pauseCurrent(goal, 2)
    }).then((value) => {
      hydrationGuard.advance(sessionID)
      setStore("goals", sessionID, (current) => applySessionGoalSnapshot(current, value))
      return value
    })
  }

  const clear = (sessionID: string) => {
    const goal = store.goals[sessionID]
    if (!goal) return Promise.resolve()
    return run(sessionID, async () => {
      const client = sdk().client
      const clearCurrent = async (current: SessionGoalInfo, retries: number): Promise<SessionGoalInfo | undefined> =>
        client.v2.session.goal
          .clear({
            sessionID,
            sessionGoalClearPayload: {
              goalID: current.id,
              expectedRevision: current.revision,
            },
          })
          .then(() => current)
          .catch(async (error) => {
            if (retries === 0) throw error
            const response = await client.v2.session.goal.get({ sessionID })
            const latest = (response.data?.data ?? null) as SessionGoalInfo | null
            if (!latest) return
            if (latest.id !== goal.id) throw error
            setStore("goals", sessionID, (value) => applySessionGoalSnapshot(value, latest))
            return clearCurrent(latest, retries - 1)
          })
      return clearCurrent(goal, 2)
    }).then((cleared) => {
      hydrationGuard.advance(sessionID)
      setStore("goals", sessionID, (current) =>
        clearSessionGoalSnapshot(current, { goalID: goal.id, revision: cleared?.revision ?? goal.revision }),
      )
    })
  }

  const current = () => {
    const sessionID = input.sessionID()
    return sessionID ? store.goals[sessionID] : undefined
  }

  return {
    goal: current,
    current,
    mode: () => store.mode,
    loading: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.loading[sessionID] : false
    },
    pending: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.pending[sessionID] : false
    },
    editRequest: () => store.editRequest,
    toggleMode: () => setStore("mode", (value) => !value),
    setMode: (value: boolean) => setStore("mode", value),
    requestEdit: () => {
      const sessionID = input.sessionID()
      if (!sessionID || !store.goals[sessionID] || store.goals[sessionID]?.status === "complete") {
        setStore("mode", true)
        return
      }
      setStore("editRequest", (value) => value + 1)
    },
    start,
    edit,
    pause,
    resume: (sessionID: string) => status(sessionID, "active"),
    clear,
  }
}

export function createSessionGoalHydrationGuard() {
  const generations = new Map<string, number>()
  return {
    capture: (sessionID: string) => generations.get(sessionID) ?? 0,
    advance: (sessionID: string) => generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1),
    current: (sessionID: string, generation: number) => (generations.get(sessionID) ?? 0) === generation,
  }
}

export type SessionRecoveryFailure = {
  error: unknown
  retry: () => Promise<void>
}

export function createSessionRecoveryProbe(input: {
  recovery: ReturnType<typeof createSessionGoalRecovery>
  scope: string
  sessionID: string
  resume: () => Promise<SessionRecoveryOutcome>
  onInterrupted: (outcome: SessionRecoveryInterruption) => Promise<void> | void
  onFailure: (failure: SessionRecoveryFailure) => void
}) {
  const run = (): Promise<void> =>
    input.recovery
      .run({
        scope: input.scope,
        sessionID: input.sessionID,
        resume: input.resume,
      })
      .then((outcome) => {
        if (outcome) markSessionV2(input.sessionID)
        if (outcome?.status !== "interrupted") return
        return input.onInterrupted(outcome)
      })
      .catch((error) => {
        input.onFailure({
          error,
          retry: run,
        })
      })

  return { run }
}

export function createSessionGoalRecovery(options?: { attempts?: number; wait?: (delay: number) => Promise<void> }) {
  const completed = new Set<string>()
  const running = new Map<string, Promise<SessionRecoveryOutcome>>()
  const attempts = Math.max(1, options?.attempts ?? 3)
  const wait = options?.wait ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)))

  const resume = (action: () => Promise<SessionRecoveryOutcome>, attempt: number): Promise<SessionRecoveryOutcome> =>
    action().catch((error) => {
      if (attempt + 1 >= attempts) throw error
      return wait(Math.min(250 * 2 ** attempt, 2_000)).then(() => resume(action, attempt + 1))
    })

  return {
    run: (input: { scope: string; sessionID: string; resume: () => Promise<SessionRecoveryOutcome> }) => {
      const key = `${input.scope}\0${input.sessionID}`
      if (completed.has(key)) return Promise.resolve(undefined)
      const current = running.get(key)
      if (current) return current
      const pending = resume(input.resume, 0)
        .then((outcome) => {
          completed.add(key)
          return outcome
        })
        .finally(() => running.delete(key))
      running.set(key, pending)
      return pending
    },
  }
}

export type SessionGoalController = ReturnType<typeof createSessionGoalController>
