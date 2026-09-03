import { rmdirSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { IS_DEV } from "./constants"
import type { SidecarListener } from "./server"
import {
  buildManifest,
  DEFAULT_SAMPLE_INTERVAL_US,
  MANIFEST_FILE_NAME,
  PROFILE_FILE_NAME,
  runStamp,
  type ProfileCapture,
  type ProfilerEnvironment,
} from "./profiler/run"

/**
 * Dev-only CPU profiling of the TurenOS sidecar.
 *
 * Scope is deliberately one process. The sidecar runs the agent loop, tool
 * execution, the projector, compaction and MCP, so it is where the cycles go.
 * The renderer and the Electron main process are not profiled and the UI says
 * so - a profile that quietly omits the process doing the work would send
 * someone optimising the wrong thing.
 *
 * The run is armed and disarmed explicitly rather than left on. Sampling
 * distorts what it measures and taxes every session, so you arm it, reproduce
 * the slow thing, and disarm it. Nothing here runs while disarmed: no timer, no
 * inspector session, and in the sidecar not even a module import.
 */

/**
 * A forgotten run must not sample forever. Ten minutes at 1 ms is roughly half a
 * million samples, which is already at the edge of what Chrome DevTools loads
 * comfortably.
 */
export const AUTO_STOP_MS = 10 * 60 * 1000

export const PROFILE_DIR_NAME = "profiles"

export type ProfilerStatus = {
  /** False in any non-dev build, and in a dev build with no sidecar yet. */
  available: boolean
  running: boolean
  startedAt: number | null
  /** Absolute path of the run directory, so the UI can show and reveal it. */
  directory: string | null
  autoStopAt: number | null
}

export type ProfilerResult = {
  directory: string
  file: string
  samples: number
  durationMs: number
  sampleRateHz: number
}

type Deps = {
  getSidecar: () => SidecarListener | null
  userDataPath: string
  environment: () => ProfilerEnvironment
  log: (message: string, extra?: Record<string, unknown>) => void
  warn: (message: string, extra?: Record<string, unknown>) => void
}

export type ProfilerController = {
  status: () => ProfilerStatus
  start: () => Promise<ProfilerStatus>
  stop: () => Promise<ProfilerResult>
  /** Synchronous, never throws, never awaits. Called on the quit path. */
  abortForQuit: () => void
  subscribe: (listener: (status: ProfilerStatus) => void) => () => void
}

const UNAVAILABLE: ProfilerStatus = {
  available: false,
  running: false,
  startedAt: null,
  directory: null,
  autoStopAt: null,
}

export function createProfilerController(deps: Deps): ProfilerController {
  // Folds to a literal in a shipped build, so everything below is dead code the
  // bundler can drop and, failing that, code no production build can reach.
  if (!IS_DEV) {
    return {
      status: () => UNAVAILABLE,
      start: () => Promise.reject(new Error("Profiler is only available in dev builds")),
      stop: () => Promise.reject(new Error("Profiler is only available in dev builds")),
      abortForQuit: () => {},
      subscribe: () => () => {},
    }
  }

  let running = false
  let startedAt: number | null = null
  let directory: string | null = null
  let autoStopTimer: NodeJS.Timeout | undefined
  let transition: Promise<unknown> | undefined
  const listeners = new Set<(status: ProfilerStatus) => void>()

  const status = (): ProfilerStatus => ({
    available: deps.getSidecar() !== null,
    running,
    startedAt,
    directory,
    autoStopAt: running && startedAt !== null ? startedAt + AUTO_STOP_MS : null,
  })

  const publish = () => {
    const current = status()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        deps.warn("profiler listener failed", { error: String(error) })
      }
    }
  }

  const clearAutoStop = () => {
    if (!autoStopTimer) return
    clearTimeout(autoStopTimer)
    autoStopTimer = undefined
  }

  const reset = () => {
    clearAutoStop()
    running = false
    startedAt = null
    directory = null
  }

  /**
   * A fresh directory per run, never a reused one. The stamp has millisecond
   * resolution, so two runs in the same millisecond would otherwise share a
   * directory and the second would overwrite the first's profile and manifest.
   * The leaf `mkdir` is deliberately non-recursive so an existing directory is
   * an EEXIST error rather than a silent success.
   */
  const createRunDirectory = async () => {
    const root = join(deps.userDataPath, PROFILE_DIR_NAME)
    await mkdir(root, { recursive: true })
    const stamp = runStamp()
    for (let attempt = 0; ; attempt++) {
      const dir = join(root, attempt === 0 ? stamp : `${stamp}-${attempt}`)
      try {
        await mkdir(dir)
        return dir
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error
      }
    }
  }

  const start = async (): Promise<ProfilerStatus> => {
    if (running) return status()
    const sidecar = deps.getSidecar()
    if (!sidecar) throw new Error("The TurenOS server is not running yet")

    const dir = await createRunDirectory()
    try {
      await sidecar.profile.start(DEFAULT_SAMPLE_INTERVAL_US)
    } catch (error) {
      // Nothing was written, so leave no empty directory behind.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    running = true
    startedAt = Date.now()
    directory = dir
    autoStopTimer = setTimeout(() => {
      deps.warn("profiler auto-stopped after reaching its time limit", { directory: dir })
      void stop().catch((error) => deps.warn("profiler auto-stop failed", { error: String(error) }))
    }, AUTO_STOP_MS)
    autoStopTimer.unref?.()

    deps.log("profiler started", { directory: dir })
    publish()
    return status()
  }

  const stop = async (): Promise<ProfilerResult> => {
    if (!running || !directory || startedAt === null) throw new Error("No profile is running")
    const dir = directory
    const armedMs = Date.now() - startedAt
    const sidecar = deps.getSidecar()

    clearAutoStop()
    running = false

    let capture: ProfileCapture | null = null
    let failure: string | null = null
    try {
      if (!sidecar) throw new Error("The TurenOS server stopped before the profile could be collected")
      const result = await sidecar.profile.stop(join(dir, PROFILE_FILE_NAME))
      capture = { file: PROFILE_FILE_NAME, ...result }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      deps.warn("profiler failed to collect sidecar profile", { error: failure })
    }

    // The manifest is written whether or not the capture worked, so a failed run
    // leaves an explanation on disk rather than an empty directory.
    const manifest = buildManifest({
      generated: new Date(),
      armedMs,
      sampleIntervalUs: DEFAULT_SAMPLE_INTERVAL_US,
      capture,
      failure,
      env: deps.environment(),
      processEnv: process.env,
    })
    await writeFile(join(dir, MANIFEST_FILE_NAME), JSON.stringify(manifest, null, 2)).catch((error) =>
      deps.warn("profiler failed to write manifest", { error: String(error) }),
    )

    reset()
    publish()

    if (!capture) throw new Error(failure ?? "The profile could not be collected")
    deps.log("profiler stopped", { directory: dir, samples: capture.samples, sampleRateHz: capture.sampleRateHz })
    return { directory: dir, ...capture }
  }

  /** Serialise start/stop so a double-click cannot interleave two transitions. */
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = (transition ?? Promise.resolve()).then(task, task)
    transition = next.catch(() => {})
    return next
  }

  return {
    status,
    start: () => serialize(start),
    stop: () => serialize(stop),

    abortForQuit: () => {
      if (!running) return
      // Deliberately does not save. Serialising a long profile can take
      // hundreds of milliseconds and quitting must stay at roughly two seconds,
      // so an in-flight run is discarded. The auto-stop cap and an explicit
      // stop are the supported ways to get an artefact.
      deps.warn("discarding in-flight CPU profile because the app is quitting", { directory })
      try {
        deps.getSidecar()?.profile.abort()
      } catch {
        // Best effort only; the sidecar is about to be told to stop anyway.
      }
      if (directory) {
        try {
          // `rmdirSync`, not a recursive remove: it fails on a non-empty
          // directory, so a profile the sidecar somehow did write is never
          // deleted. An abandoned run leaves nothing behind either way.
          rmdirSync(directory)
        } catch {
          // Already gone, not empty, or not ours to remove.
        }
      }
      reset()
      publish()
    },

    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
