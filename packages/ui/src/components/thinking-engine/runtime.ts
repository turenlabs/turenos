type FrameCallback = (time: number) => void
type ScheduleFrame = (callback: FrameRequestCallback) => number
type CancelFrame = (id: number) => void

export function createFrameScheduler(schedule: ScheduleFrame, cancel: CancelFrame) {
  const callbacks = new Set<FrameCallback>()
  const tick = (time: number) => {
    frame = undefined
    callbacks.forEach((callback) => callback(time))
    if (callbacks.size > 0) frame = schedule(tick)
  }
  let frame: number | undefined

  return {
    subscribe(callback: FrameCallback) {
      callbacks.add(callback)
      if (frame === undefined) frame = schedule(tick)
      return () => {
        callbacks.delete(callback)
        if (callbacks.size > 0 || frame === undefined) return
        cancel(frame)
        frame = undefined
      }
    },
  }
}

export const thinkingFrameScheduler = createFrameScheduler(
  (callback) => requestAnimationFrame(callback),
  (id) => cancelAnimationFrame(id),
)
