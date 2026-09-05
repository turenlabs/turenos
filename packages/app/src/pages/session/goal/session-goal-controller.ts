import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionRecoveryOutcome } from "@turenlabs/sdk/v2/client"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { Identifier } from "@/utils/id"
import { ScopedKey } from "@/utils/server-scope"
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
  const owner = createSessionOwnership(() => JSON.stringify([sdk().scope, input.sessionKey()]))
  const recovery = input.recovery ?? createSessionGoalRecovery()
  const [store, setStore] = createStore({
    goals: {} as Record<string, SessionGoalInfo | undefined>,
    loading: {} as Record<string, number | undefined>,
    pending: {} as Record<string, number | undefined>,
    mode: false,
    editRequest: 0,
  })
  let hydration = 0
  const hydrationGuard = createSessionGoalHydrationGuard()

  createEffect(() => {
    sdk().scope
    input.sessionKey()
    setStore("mode", false)
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    const current = sdk()
    const captured = owner.capture()
    const request = ++hydration
    if (!sessionID) return
    const key = ScopedKey.from(current.scope, sessionID)
    const events = hydrationGuard.capture(key)

    setStore("loading", key, request)
    const goalRequest = current.client.v2.session.goal
      .get({ sessionID })
      .then((result) => {
        if (request !== hydration || !captured.current()) return
        if (!hydrationGuard.current(key, events)) return
        const goal = (result.data?.data ?? null) as SessionGoalInfo | null
        setStore("goals", key, (current) => applySessionGoalSnapshot(current, goal ?? undefined))
      })
      .catch(() => undefined)
    const recoveryProbe = createSessionRecoveryProbe({
      recovery,
      scope: current.scope,
      sessionID,
      resume: () => current.client.v2.session.resume({ sessionID }).then((result) => result.data!.data),
      onInterrupted: (outcome) => {
        if (request !== hydration || !captured.current()) return
        hydrationGuard.advance(key)
        input.onInterrupted?.(outcome)
        const recoveredEvents = hydrationGuard.capture(key)
        return current.client.v2.session.goal.get({ sessionID }).then((result) => {
          if (request !== hydration || !captured.current()) return
          if (!hydrationGuard.current(key, recoveredEvents)) return
          const goal = (result.data?.data ?? null) as SessionGoalInfo | null
          setStore("goals", key, (current) => applySessionGoalSnapshot(current, goal ?? undefined))
        })
      },
      onFailure: (failure) => {
        if (request !== hydration || !captured.current()) return
        input.onRecoveryError?.(failure)
      },
    })
    const recoveryRequest = recoveryProbe.run()

    void Promise.all([goalRequest, recoveryRequest]).finally(() => {
      if (store.loading[key] === request) setStore("loading", key, undefined)
    })
  })

  createEffect(() => {
    const current = sdk()
    const scope = current.scope
    const updated = current.event.on("session.next.goal.updated", (event) => {
      const key = ScopedKey.from(scope, event.properties.sessionID)
      hydrationGuard.advance(key)
      // Admission details are deliberately ignored; only the public goal snapshot belongs in UI state.
      setStore("goals", key, (goal) => applySessionGoalSnapshot(goal, event.properties.goal))
    })
    const cleared = current.event.on("session.next.goal.cleared", (event) => {
      const key = ScopedKey.from(scope, event.properties.sessionID)
      hydrationGuard.advance(key)
      setStore("goals", key, (goal) =>
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

  const run = async <T>(key: string, mutation: () => Promise<T>) => {
    setStore("pending", key, (count) => (count ?? 0) + 1)
    try {
      return await mutation()
    } finally {
      // Navigation changes the view, not ownership of the outstanding mutation.
      // Release only this operation; a newer operation may still be waiting.
      setStore("pending", key, (count) => (count && count > 1 ? count - 1 : undefined))
    }
  }

  const start = (value: {
    sessionID: string
    objective: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    client?: DirectorySDK["client"]
    scope?: DirectorySDK["scope"]
  }) => {
    const client = value.client ?? sdk().client
    const scope = value.scope ?? sdk().scope
    const sessionKey = ScopedKey.from(scope, value.sessionID)
    const captured = owner.capture()
    const key = [
      scope,
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

    const promise = run(sessionKey, () =>
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
      hydrationGuard.advance(sessionKey)
      setStore("goals", sessionKey, (current) => applySessionGoalSnapshot(current, goal))
      goalSetAttempts.delete(key)
      if (captured.current() && scope === sdk().scope) setStore("mode", false)
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
    scope?: DirectorySDK["scope"]
  }) => {
    const scope = value.scope ?? sdk().scope
    const key = ScopedKey.from(scope, value.sessionID)
    const captured = owner.capture()
    const goal = value.goal ?? store.goals[key]
    if (!goal) return Promise.reject(new Error("No active goal"))
    const client = value.client ?? sdk().client
    return run(key, () =>
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
      hydrationGuard.advance(key)
      setStore("goals", key, (current) => applySessionGoalSnapshot(current, next))
      if (captured.current() && scope === sdk().scope) setStore("mode", false)
      return next
    })
  }

  const status = (sessionID: string, next: SessionGoalStatus, current?: SessionGoalInfo) => {
    const source = sdk()
    const key = ScopedKey.from(source.scope, sessionID)
    const goal = current ?? store.goals[key]
    if (!goal) return Promise.reject(new Error("No active goal"))
    return run(key, () =>
      source.client.v2.session.goal
        .status({
          sessionID,
          sessionGoalStatusPayload: {
            goalID: goal.id,
            expectedRevision: goal.revision,
            status: next,
          },
        })
        .then((result) => result.data!.data),
    ).then((value) => {
      hydrationGuard.advance(key)
      setStore("goals", key, (current) => applySessionGoalSnapshot(current, value))
      return value
    })
  }

  const pause = (sessionID: string, options?: { signal?: AbortSignal }) => {
    const source = sdk()
    const key = ScopedKey.from(source.scope, sessionID)
    const goal = store.goals[key]
    if (!goal) return Promise.reject(new Error("No active goal"))
    if (goal.status === "paused") return Promise.resolve(goal)
    if (goal.status !== "active") return Promise.reject(new Error("Goal is not active"))

    return run(key, async () => {
      const client = source.client
      const pauseCurrent = async (current: SessionGoalInfo, retries: number): Promise<SessionGoalInfo> =>
        client.v2.session.goal
          .status(
            {
              sessionID,
              sessionGoalStatusPayload: {
                goalID: current.id,
                expectedRevision: current.revision,
                status: "paused",
              },
            },
            options,
          )
          .then((result) => result.data!.data)
          .catch(async (error) => {
            if (retries === 0 || options?.signal?.aborted) throw error
            const response = await client.v2.session.goal.get({ sessionID }, options)
            const latest = (response.data?.data ?? null) as SessionGoalInfo | null
            if (!latest || latest.id !== goal.id) throw error
            setStore("goals", key, (value) => applySessionGoalSnapshot(value, latest))
            if (latest.status === "paused") return latest
            if (latest.status !== "active") throw error
            return pauseCurrent(latest, retries - 1)
          })
      return pauseCurrent(goal, 2)
    }).then((value) => {
      hydrationGuard.advance(key)
      setStore("goals", key, (current) => applySessionGoalSnapshot(current, value))
      return value
    })
  }

  const clear = (sessionID: string) => {
    const source = sdk()
    const key = ScopedKey.from(source.scope, sessionID)
    const goal = store.goals[key]
    if (!goal) return Promise.resolve()
    return run(key, async () => {
      const client = source.client
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
            setStore("goals", key, (value) => applySessionGoalSnapshot(value, latest))
            return clearCurrent(latest, retries - 1)
          })
      return clearCurrent(goal, 2)
    }).then((cleared) => {
      hydrationGuard.advance(key)
      setStore("goals", key, (current) =>
        clearSessionGoalSnapshot(current, { goalID: goal.id, revision: cleared?.revision ?? goal.revision }),
      )
    })
  }

  const current = () => {
    const sessionID = input.sessionID()
    return sessionID ? store.goals[ScopedKey.from(sdk().scope, sessionID)] : undefined
  }

  return {
    goal: current,
    current,
    mode: () => store.mode,
    loading: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.loading[ScopedKey.from(sdk().scope, sessionID)] : false
    },
    pending: () => {
      const sessionID = input.sessionID()
      return sessionID ? !!store.pending[ScopedKey.from(sdk().scope, sessionID)] : false
    },
    editRequest: () => store.editRequest,
    toggleMode: () => setStore("mode", (value) => !value),
    setMode: (value: boolean) => setStore("mode", value),
    requestEdit: () => {
      const sessionID = input.sessionID()
      if (!sessionID || !current() || current()?.status === "complete") {
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
