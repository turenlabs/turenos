import { describe, expect, test } from "bun:test"
import { createAcpLoginController, googleLoginURL, type AcpLoginState, type AcpLoginView } from "../src/acp-login"

const url = "https://accounts.google.com/o/oauth2/v2/auth"
const waiting: AcpLoginState = { id: "attempt-one", status: "waiting", url }

function deferred<T>() {
  const pending = {} as { resolve: (value: T) => void; reject: (error: unknown) => void }
  const promise = new Promise<T>((resolve, reject) => Object.assign(pending, { resolve, reject }))
  return { promise, ...pending }
}

function setup(overrides: Partial<Parameters<typeof createAcpLoginController>[0]> = {}) {
  const states: AcpLoginView[] = []
  const cancelled: string[] = []
  const completed: string[] = []
  const controller = createAcpLoginController({
    authorize: async () => waiting,
    status: async () => waiting,
    cancel: async (id) => {
      cancelled.push(id)
    },
    complete: async () => {
      completed.push("refresh")
    },
    onAuthenticated: () => {
      completed.push("success")
    },
    onState: (state) => {
      states.push(state)
    },
    failure: "Request failed",
    cancellationFailure: "Cancellation unconfirmed",
    ...overrides,
  })
  return { controller, states, cancelled, completed }
}

describe("Antigravity ACP login controller", () => {
  test("starts only one authorization and completes only on native authentication success", async () => {
    const authorization = deferred<AcpLoginState>()
    let started = 0
    const flow = setup({
      authorize: () => {
        started++
        return authorization.promise
      },
    })
    const first = flow.controller.start()
    await flow.controller.start()
    expect(started).toBe(1)
    expect(flow.completed).toEqual([])
    authorization.resolve({ id: "attempt-one", status: "authenticated" })
    await first
    expect(flow.completed).toEqual(["refresh", "success"])
    expect(flow.states.at(-1)?.phase).toBe("authenticated")
    flow.controller.dispose()
    expect(flow.cancelled).toEqual([])
  })

  test("cancels a late authorization response after the dialog closes", async () => {
    const authorization = deferred<AcpLoginState>()
    const cancelled = deferred<string>()
    const flow = setup({
      authorize: () => authorization.promise,
      cancel: async (id) => {
        cancelled.resolve(id)
      },
    })
    const starting = flow.controller.start()
    flow.controller.dispose()
    authorization.resolve(waiting)
    await starting
    expect(await cancelled.promise).toBe(waiting.id)
    expect(flow.states.map((state) => state.phase)).toEqual(["starting"])
    expect(flow.completed).toEqual([])
  })

  test("keeps retry blocked until cancellation of an unresolved start is confirmed", async () => {
    const authorization = deferred<AcpLoginState>()
    const cancelled = deferred<void>()
    let started = 0
    const flow = setup({
      authorize: () => {
        started++
        return authorization.promise
      },
      cancel: () => cancelled.promise,
    })
    const starting = flow.controller.start()
    const cancellation = flow.controller.cancel()
    await flow.controller.start()
    expect(started).toBe(1)
    expect(flow.states.at(-1)?.phase).toBe("cancelling")
    authorization.resolve(waiting)
    await starting
    await flow.controller.start()
    expect(started).toBe(1)
    cancelled.resolve(undefined)
    await cancellation
    expect(flow.states.at(-1)?.phase).toBe("cancelled")
    flow.controller.dispose()
  })

  test("aborts an in-flight status request and ignores stale authentication success", async () => {
    const polling = deferred<AbortSignal>()
    const status = deferred<AcpLoginState>()
    const flow = setup({
      status: (_id, signal) => {
        polling.resolve(signal)
        return status.promise
      },
    })
    await flow.controller.start()
    const signal = await polling.promise
    await flow.controller.cancel()
    expect(signal.aborted).toBe(true)
    expect(flow.cancelled).toEqual([waiting.id])
    status.resolve({ id: waiting.id, status: "authenticated" })
    await status.promise
    await Promise.resolve()
    expect(flow.completed).toEqual([])
    expect(flow.states.at(-1)?.phase).toBe("cancelled")
    flow.controller.dispose()
  })

  test("does not overlap status polling while a request is unresolved", async () => {
    const polling = deferred<void>()
    const status = deferred<AcpLoginState>()
    let requests = 0
    const flow = setup({
      status: () => {
        requests++
        polling.resolve(undefined)
        return status.promise
      },
    })
    await flow.controller.start()
    await polling.promise
    expect(requests).toBe(1)
    const cancellation = flow.controller.cancel()
    status.resolve(waiting)
    await cancellation
    expect(requests).toBe(1)
    flow.controller.dispose()
  })

  test("does not close a disposed or retargeted dialog after provider refresh finishes", async () => {
    const refresh = deferred<void>()
    const completing = deferred<void>()
    const flow = setup({
      authorize: async () => ({ id: waiting.id, status: "authenticated" }),
      complete: () => {
        completing.resolve(undefined)
        return refresh.promise
      },
    })
    const starting = flow.controller.start()
    await completing.promise
    flow.controller.dispose()
    refresh.resolve(undefined)
    await starting
    expect(flow.completed).toEqual([])
    expect(flow.cancelled).toEqual([])
  })

  test("cancels a mismatched status ID rather than completing another attempt", async () => {
    const failed = deferred<void>()
    const flow = setup({
      status: async () => ({ id: "another-attempt", status: "authenticated" }),
      onState: (state) => {
        if (state.phase === "error") failed.resolve(undefined)
      },
    })
    await flow.controller.start()
    await failed.promise
    expect(flow.cancelled).toEqual([waiting.id])
    expect(flow.completed).toEqual([])
    flow.controller.dispose()
  })

  test("rejects unexpected browser URLs and does not expose them", async () => {
    const flow = setup({ authorize: async () => ({ ...waiting, url: "https://accounts.google.com.evil.test/login" }) })
    await flow.controller.start()
    expect(flow.states.at(-1)).toEqual({ phase: "error", error: "Request failed" })
    expect(flow.states.every((state) => !state.url)).toBe(true)
    expect(flow.cancelled).toEqual([waiting.id])
    flow.controller.dispose()
  })

  test("reports unconfirmed cancellation without claiming the native process stopped", async () => {
    const flow = setup({
      cancel: async () => {
        throw new Error("offline")
      },
    })
    await flow.controller.start()
    await flow.controller.cancel()
    expect(flow.states.at(-1)).toEqual({ phase: "error", error: "Cancellation unconfirmed" })
    flow.controller.dispose()
  })
})

test("Google sign-in links require the exact HTTPS account origin and OAuth path", () => {
  expect(googleLoginURL(url)).toBe(url)
  for (const value of [
    "javascript:alert(1)",
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
    "https://user@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/signin",
  ])
    expect(googleLoginURL(value)).toBeUndefined()
})
