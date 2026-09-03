import type { Session } from "node:inspector"

/**
 * In-process V8 CPU profiler, shared by the Electron main process and the
 * `utilityProcess` sidecar. Both are Node environments, so both can drive the
 * V8 inspector directly.
 *
 * This deliberately uses `new inspector.Session()` rather than
 * `inspector.open()` or an `--inspect` argv flag. A `Session` speaks the V8
 * inspector protocol over an in-process channel; it never binds a socket. That
 * matters because a profiler that leaves a debugger port listening on a
 * developer's machine is a worse problem than the one it solves, and because it
 * means a profiling run needs no process restart - you arm it, reproduce the
 * slow thing, and disarm it inside one session.
 *
 * `node:inspector` is imported lazily so that a disarmed profiler costs nothing
 * at all: no module evaluation, no session, no sampling timer.
 */

import { DEFAULT_SAMPLE_INTERVAL_US } from "./run"

export type CpuProfileCapture = {
  /** The raw V8 profile, shaped for a `.cpuprofile` file. */
  profile: unknown
  /** Number of samples V8 actually took. Zero means the profile is worthless. */
  samples: number
  /** Wall time V8 believes it was profiling for. */
  durationMs: number
  /** Samples per second actually achieved, which is not always what was asked for. */
  sampleRateHz: number
}

type InspectorPost = (method: string, params?: Record<string, unknown>) => Promise<unknown>

type ProfilerStopResult = {
  profile?: {
    samples?: unknown[]
    startTime?: number
    endTime?: number
  }
}

export type V8CpuProfiler = {
  running: () => boolean
  start: (sampleIntervalUs?: number) => Promise<void>
  stop: () => Promise<CpuProfileCapture>
  /** Tear down without collecting anything. Never throws, never awaits V8. */
  abort: () => void
}

export function createV8CpuProfiler(): V8CpuProfiler {
  let session: Session | undefined
  let starting: Promise<void> | undefined

  const postOn = (active: Session): InspectorPost => {
    return (method, params) =>
      new Promise((resolve, reject) => {
        // The typed overloads only cover known domain literals; this wrapper is
        // generic over method names on purpose.
        const post = active.post.bind(active) as (
          method: string,
          params: Record<string, unknown> | undefined,
          callback: (error: Error | null, result?: unknown) => void,
        ) => void
        post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
      })
  }

  const disconnect = () => {
    const active = session
    session = undefined
    starting = undefined
    if (!active) return
    try {
      active.disconnect()
    } catch {
      // A disconnected or already-torn-down session is exactly the state we want.
    }
  }

  return {
    running: () => session !== undefined,

    async start(sampleIntervalUs = DEFAULT_SAMPLE_INTERVAL_US) {
      if (starting) return starting
      if (session) throw new Error("CPU profiler already running")

      starting = (async () => {
        const inspector = await import("node:inspector")
        const active = new inspector.Session()
        active.connect()
        const post = postOn(active)
        try {
          await post("Profiler.enable")
          await post("Profiler.setSamplingInterval", { interval: sampleIntervalUs })
          await post("Profiler.start")
        } catch (error) {
          try {
            active.disconnect()
          } catch {
            // Nothing usable to clean up; the throw below is the real signal.
          }
          throw error
        }
        session = active
      })()

      try {
        await starting
      } finally {
        starting = undefined
      }
    },

    async stop() {
      const active = session
      if (!active) throw new Error("CPU profiler is not running")
      const post = postOn(active)
      try {
        const result = (await post("Profiler.stop")) as ProfilerStopResult
        const profile = result?.profile
        const samples = profile?.samples?.length ?? 0
        const startTime = profile?.startTime ?? 0
        const endTime = profile?.endTime ?? 0
        const durationUs = Math.max(0, endTime - startTime)
        return {
          profile,
          samples,
          durationMs: durationUs / 1000,
          sampleRateHz: durationUs > 0 ? Math.round(samples / (durationUs / 1_000_000)) : 0,
        }
      } finally {
        disconnect()
      }
    },

    abort: disconnect,
  }
}
