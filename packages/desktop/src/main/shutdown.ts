type QuitEvent = {
  preventDefault(): void
}

type Options = {
  flushWindowState: () => Promise<void>
  drainPersistence: () => Promise<void>
  stopSidecars: () => Promise<void>
  stopWslServers: () => void
  setAppQuitting: () => void
  quit: () => void
  failed: (error: unknown) => void
}

export function createShutdownCoordinator(options: Options) {
  let stopping: Promise<void> | undefined
  let complete = false

  /**
   * Teardown steps are independent, and a quit must finish even when one fails.
   *
   * These used to run as a single `await` chain whose rejection reached
   * `beforeQuit`'s `failed` handler, which cancels the quit. By then Electron
   * has already closed the windows, so a failing step left a running app with
   * no window that could not be quit by menu, osascript or SIGTERM - observed
   * with both a storage 400 and a SessionTask.ConflictError. Losing a window
   * flush or a persistence drain is a far smaller harm than an unkillable,
   * windowless process, so every step is reported and the quit proceeds.
   */
  const step = async (name: string, run: () => Promise<void> | void) => {
    try {
      await run()
    } catch (error) {
      options.failed(new Error(`shutdown step "${name}" failed`, { cause: error }))
    }
  }

  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      await step("flushWindowState", options.flushWindowState)
      await step("drainPersistence", options.drainPersistence)
      await step("stopSidecars", options.stopSidecars)
      await step("stopWslServers", options.stopWslServers)
      complete = true
    })()
    return stopping
  }

  return {
    stop,
    beforeQuit(event: QuitEvent) {
      options.setAppQuitting()
      if (complete) return
      event.preventDefault()
      // `stop` never rejects now: each step reports itself and the quit still
      // completes, so there is no path back to a windowless running app.
      void stop().then(options.quit, options.failed)
    },
  }
}
