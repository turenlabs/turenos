type Listener = { stop(): Promise<void> }

export function createSidecarSupervisor<T extends { listener: Listener }>(options: {
  spawn: (onExit: (code: number) => void) => Promise<T>
  ready: (result: T) => void
  exited: (code: number) => void
  respawning: (code: number, attempt: number) => void
  exhausted: (code: number) => void
  failed: (error: unknown, attempt: number) => void
  delayMs?: number
}) {
  let generation = 0
  let stopped = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const start = async (): Promise<T> => {
    if (stopped) throw new Error("Sidecar supervisor stopped")
    const owner = ++generation
    const result = await options.spawn((code) => {
      if (stopped || owner !== generation) return
      generation++
      options.exited(code)
      if (attempts >= 5) {
        options.exhausted(code)
        return
      }
      const attempt = ++attempts
      options.respawning(code, attempt)
      timer = setTimeout(
        () => {
          timer = undefined
          if (stopped) return
          void start().catch((error) => options.failed(error, attempt))
        },
        (options.delayMs ?? 1_000) * attempt,
      )
    })
    // Shutdown can occur while the child startup promise is still pending.
    if (stopped || owner !== generation) {
      await result.listener.stop()
      throw new Error("Sidecar startup superseded")
    }
    options.ready(result)
    return result
  }

  return {
    start,
    stop() {
      stopped = true
      generation++
      clearTimeout(timer)
      timer = undefined
    },
  }
}
