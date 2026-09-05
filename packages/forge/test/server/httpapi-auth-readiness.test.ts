import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { initializeAuthApp, withAuthProbeDeadline } from "./httpapi-exercise/auth-readiness"

test("auth readiness waits for lazy router initialization before the short probe budget", async () => {
  const app = HttpRouter.toWebHandler(
    Layer.unwrap(
      Effect.sleep("1100 millis").pipe(
        Effect.as(HttpRouter.add("GET", "/global/health", Effect.succeed(HttpServerResponse.empty({ status: 401 })))),
      ),
    ),
    { disableLogger: true },
  )
  try {
    await Effect.runPromise(initializeAuthApp({ request: (input) => app.handler(new Request(input)) }, "/tmp"))
    const response = await app.handler(
      new Request("http://localhost/global/health", { signal: AbortSignal.timeout(1_000) }),
    )
    expect(response.status).toBe(401)
    await response.body?.cancel()
  } finally {
    await app.dispose()
  }
})

test("auth readiness fails if the protected route permits missing credentials", async () => {
  const app = HttpRouter.toWebHandler(
    HttpRouter.add("GET", "/global/health", Effect.succeed(HttpServerResponse.empty({ status: 200 }))),
    { disableLogger: true },
  )
  try {
    await expect(
      Effect.runPromise(initializeAuthApp({ request: (input) => app.handler(new Request(input)) }, "/tmp")),
    ).rejects.toThrow("auth readiness expected 401")
  } finally {
    await app.dispose()
  }
})

test("successful probes clear their deadline instead of aborting later", async () => {
  const app = HttpRouter.toWebHandler(
    HttpRouter.add("GET", "/global/health", Effect.succeed(HttpServerResponse.empty({ status: 401 }))),
    { disableLogger: true },
  )
  const signals: AbortSignal[] = []
  try {
    const response = await withAuthProbeDeadline(new AbortController().signal, (signal) => {
      signals.push(signal)
      return app.handler(new Request("http://localhost/global/health", { signal }))
    })
    expect(response?.status).toBe(401)
    await response?.body?.cancel()
    await Bun.sleep(1_100)
    expect(signals[0]?.aborted).toBe(false)
  } finally {
    await app.dispose()
  }
})

test("slow and cancelled probes abort the in-flight request", async () => {
  const app = HttpRouter.toWebHandler(
    HttpRouter.add(
      "GET",
      "/slow",
      Effect.sleep("10 seconds").pipe(Effect.as(HttpServerResponse.empty({ status: 200 }))),
    ),
    { disableLogger: true },
  )
  const signals: AbortSignal[] = []
  const request = (signal: AbortSignal) => {
    signals.push(signal)
    return app.handler(new Request("http://localhost/slow", { signal }))
  }
  try {
    expect(await withAuthProbeDeadline(new AbortController().signal, request)).toBeUndefined()
    expect(signals[0]?.aborted).toBe(true)
    const parent = new AbortController()
    const pending = withAuthProbeDeadline(parent.signal, request)
    parent.abort("scenario cancelled")
    expect(await pending).toBeUndefined()
    expect(signals[1]?.aborted).toBe(true)
    expect(await withAuthProbeDeadline(parent.signal, request)).toBeUndefined()
    expect(signals).toHaveLength(2)
  } finally {
    await app.dispose()
  }
})

test("authorized route work can finish after the fast missing-credential deadline", async () => {
  const app = HttpRouter.toWebHandler(
    HttpRouter.add(
      "GET",
      "/slow",
      Effect.sleep("1100 millis").pipe(Effect.as(HttpServerResponse.empty({ status: 200 }))),
    ),
    { disableLogger: true },
  )
  try {
    const response = await withAuthProbeDeadline(
      new AbortController().signal,
      (signal) => app.handler(new Request("http://localhost/slow", { signal })),
      2_000,
    )
    expect(response?.status).toBe(200)
    await response?.body?.cancel()
  } finally {
    await app.dispose()
  }
})
