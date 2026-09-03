/**
 * Dev-only CPU profiler contract.
 *
 * A run captures the **sidecar process only** - the process that runs the agent
 * loop, tool execution, the projector, compaction and MCP. It does not capture
 * renderer (UI) or Electron main-process time. Every surface that shows this
 * has to say so, or someone will go looking for UI jank in a file that never
 * contained any.
 */

export type ProfilerStatus = {
  /** Dev build with a live sidecar. False everywhere else, including all shipped builds. */
  available: boolean
  running: boolean
  /** Epoch millis, for showing elapsed time. */
  startedAt: number | null
  /** Absolute path of the run directory. */
  directory: string | null
  /** Epoch millis at which a forgotten run stops itself. */
  autoStopAt: number | null
}

export type ProfilerResult = {
  directory: string
  /** File name inside `directory`, not an absolute path. */
  file: string
  samples: number
  /** Wall time V8 believes it sampled for. */
  durationMs: number
  /** Samples per second actually achieved. Zero samples means the file is worthless. */
  sampleRateHz: number
}

export type ProfilerPlatform = {
  status(): Promise<ProfilerStatus>
  start(): Promise<ProfilerStatus>
  stop(): Promise<ProfilerResult>
  subscribe(cb: (status: ProfilerStatus) => void): () => void
}
