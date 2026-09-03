export const TEARDOWN_STEP_TIMEOUT_MS = 8_000

type Warn = (message: string, ...args: unknown[]) => void

export type TeardownTimeoutOptions = {
  warn: Warn
  timeoutMs?: number
}

/**
 * Bounds a shutdown step so a hung dependency can't block the rest of teardown
 * forever. `flushWindowState` and `drainPersistence` both round-trip through the
 * sidecar's HTTP server; without a timeout an unresponsive (not merely crashed)
 * sidecar wedges `before-quit` indefinitely, and `stopSidecars` - the step that
 * would actually kill it - never runs, so a "polite" quit does nothing and the
 * process has to be force-killed. A real, fast failure (thrown before the
 * timeout elapses) still propagates and still aborts the quit, same as before -
 * only a step that never settles gets skipped.
 */
export function withTeardownTimeout(label: string, task: () => Promise<void>, options: TeardownTimeoutOptions) {
  const timeoutMs = options.timeoutMs ?? TEARDOWN_STEP_TIMEOUT_MS
  return () =>
    new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        options.warn(`${label} did not finish before quitting; continuing shutdown without it`)
        resolve()
      }, timeoutMs)
      task().then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        (error) => {
          clearTimeout(timer)
          if (settled) {
            options.warn(`${label} failed after already timing out during shutdown`, error)
            return
          }
          settled = true
          reject(error)
        },
      )
    })
}
