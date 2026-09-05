import { Effect } from "effect"
import type { BackendApp } from "./types"

/** Build the lazy router once before applying the one-second authorization probe budget. */
export function initializeAuthApp(app: BackendApp, directory: string) {
  return Effect.promise(async (signal) => {
    const response = await app.request(
      new Request("http://localhost/global/health", {
        headers: { "x-forge-directory": directory },
        signal,
      }),
    )
    await response.body?.cancel()
    if (response.status !== 401) throw new Error(`auth readiness expected 401, got ${response.status}`)
  }).pipe(Effect.timeout("30 seconds"))
}

/** Keep cancellation and each probe deadline scoped to the actual request. */
export async function withAuthProbeDeadline<A>(
  parent: AbortSignal,
  request: (signal: AbortSignal) => Promise<A>,
  timeout = 1_000,
) {
  const controller = new AbortController()
  const signal = AbortSignal.any([parent, controller.signal])
  const aborted = Promise.withResolvers<undefined>()
  const onAbort = () => aborted.resolve(undefined)
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort("auth probe timed out"), timeout)
  try {
    if (signal.aborted) return undefined
    return await Promise.race([request(signal), aborted.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
