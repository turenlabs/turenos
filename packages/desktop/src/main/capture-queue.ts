// Serializes Security Browser CDP events in arrival order while bounding the
// backlog. Over-limit events are dropped through the drop hook — a capture gap,
// never a destroyed target — because queued params are cheap and the retained
// body bytes are bounded elsewhere.
export const CAPTURE_BACKLOG_LIMIT = 64

export interface CaptureQueue {
  readonly pending: Promise<unknown>
  push(method: string, params: unknown, sessionID: string | undefined): void
}

export function createCaptureQueue(options: {
  run: (method: string, params: unknown, sessionID: string | undefined) => Promise<void>
  drop: (method: string, params: unknown, sessionID: string | undefined, dropped: number) => void
  error: (error: unknown) => void
  limit?: number
}): CaptureQueue {
  const limit = options.limit ?? CAPTURE_BACKLOG_LIMIT
  let queued = 0
  let dropped = 0
  let pending: Promise<unknown> = Promise.resolve()
  return {
    get pending() {
      return pending
    },
    push(method, params, sessionID) {
      if (queued >= limit) {
        options.drop(method, params, sessionID, ++dropped)
        return
      }
      queued++
      pending = pending
        .then(async () => {
          try {
            await options.run(method, params, sessionID)
          } finally {
            queued--
          }
        })
        .catch(options.error)
    },
  }
}
