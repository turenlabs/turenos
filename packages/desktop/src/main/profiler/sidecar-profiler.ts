import { writeFile } from "node:fs/promises"
import { createV8CpuProfiler } from "./v8-cpu-profiler"
import { DEFAULT_SAMPLE_INTERVAL_US, isProfileOutputPath } from "./run"

/**
 * The sidecar half of the CPU profiler.
 *
 * The sidecar is the process worth profiling - it runs the agent loop, tool
 * execution, the projector, compaction and MCP - so this is the capture that
 * has to work. It is driven over the existing `parentPort` command channel
 * rather than over HTTP, which keeps the protocol package, the generated client
 * and `packages/core` entirely out of it.
 *
 * The sidecar writes its own profile to disk instead of posting it back to the
 * parent. A ten-minute run is hundreds of thousands of samples and tens of
 * megabytes; structured-cloning that across the message port would stall both
 * processes for no reason.
 */

export type SidecarProfileCommand =
  | { type: "profile-start"; sampleIntervalUs: number }
  | { type: "profile-stop"; path: string }
  | { type: "profile-abort" }

export type SidecarProfileMessage =
  | { type: "profile-started"; ok: boolean; error?: string }
  | {
      type: "profile-stopped"
      ok: boolean
      samples?: number
      durationMs?: number
      sampleRateHz?: number
      error?: string
    }

export function parseProfileCommand(value: unknown): SidecarProfileCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Record<string, unknown>
  if (command.type === "profile-abort") return { type: "profile-abort" }
  if (command.type === "profile-start") {
    const interval = command.sampleIntervalUs
    const sampleIntervalUs =
      typeof interval === "number" && Number.isFinite(interval) && interval >= 10 && interval <= 1_000_000
        ? Math.round(interval)
        : DEFAULT_SAMPLE_INTERVAL_US
    return { type: "profile-start", sampleIntervalUs }
  }
  if (command.type === "profile-stop") {
    if (!isProfileOutputPath(command.path)) return
    return { type: "profile-stop", path: command.path }
  }
  return
}

export type SidecarProfiler = {
  running: () => boolean
  /** Drop any in-flight profile without writing. Used on teardown. */
  abort: () => void
  handle: (command: SidecarProfileCommand, reply: (message: SidecarProfileMessage) => void) => Promise<void>
}

export function createSidecarProfiler(): SidecarProfiler {
  const profiler = createV8CpuProfiler()

  return {
    running: profiler.running,
    abort: profiler.abort,

    async handle(command, reply) {
      if (command.type === "profile-abort") {
        profiler.abort()
        return
      }

      if (command.type === "profile-start") {
        try {
          await profiler.start(command.sampleIntervalUs)
          reply({ type: "profile-started", ok: true })
        } catch (error) {
          reply({ type: "profile-started", ok: false, error: message(error) })
        }
        return
      }

      try {
        const capture = await profiler.stop()
        await writeFile(command.path, JSON.stringify(capture.profile))
        reply({
          type: "profile-stopped",
          ok: true,
          samples: capture.samples,
          durationMs: capture.durationMs,
          sampleRateHz: capture.sampleRateHz,
        })
      } catch (error) {
        reply({ type: "profile-stopped", ok: false, error: message(error) })
      }
    },
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
