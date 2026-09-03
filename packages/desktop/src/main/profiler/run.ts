import { isAbsolute, join } from "node:path"

/**
 * Pure run bookkeeping for the sidecar CPU profiler: naming, path validation
 * and the manifest. Free of Electron and `node:inspector` imports so it can be
 * unit-tested directly.
 */

/** The one process this profiler covers. */
export const PROFILED_PROCESS = "sidecar" as const

/**
 * 1 ms, matching V8's own default and Chrome DevTools. Measured overhead on a
 * CPU-bound workload is at or below noise here, where 100 us costs a consistent
 * ~3%. Lives in this module rather than next to the inspector code so that the
 * controller can read it without pulling `node:inspector` into the main-process
 * bundle.
 */
export const DEFAULT_SAMPLE_INTERVAL_US = 1_000

export const PROFILE_FILE_NAME = "sidecar.cpuprofile"
export const MANIFEST_FILE_NAME = "manifest.json"

export type ProfilerEnvironment = {
  version: string
  name: string
  channel: string
  packaged: boolean
  platform: string
  arch: string
  versions: Record<string, string | undefined>
  userData: string
}

export type ProfileCapture = {
  file: string
  samples: number
  durationMs: number
  sampleRateHz: number
}

export type ProfileManifest = {
  generated: string
  /** Always "sidecar". Present so the file is self-describing when it is read months later. */
  process: typeof PROFILED_PROCESS
  /** Wall time between arming and disarming, which is longer than V8's own profile duration. */
  armedMs: number
  sampleIntervalUs: number
  capture: ProfileCapture | null
  failure: string | null
  app: ProfilerEnvironment & { databaseHint: string }
  /**
   * What a reader must know to not over-read this file. A profile that silently
   * omits the process doing the work is worse than no profile, so the omissions
   * travel with the artefact rather than living only in the UI.
   */
  notes: string[]
}

/** `20260729-084500-123`, sortable and filesystem-safe on every platform. */
export function runStamp(now: Date = new Date()) {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}`
}

/**
 * A path the sidecar is willing to write a profile to. The sidecar only ever
 * receives this from its own parent, but every other field on that channel is
 * validated by `parseCommand` and this keeps that property.
 */
export function isProfileOutputPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false
  if (!value.endsWith(".cpuprofile")) return false
  if (value.includes("\0") || value.includes("..")) return false
  return isAbsolute(value)
}

/**
 * Which SQLite file this installation's sidecar is talking to, derived the same
 * way `packages/core/src/database/database.ts` derives it. Recorded because
 * `forge.db`, `forge-dev.db` and `forge-local.db` are trivially confused, and a
 * profile is much less useful when you cannot tell which installation produced
 * it. Best-effort and labelled a hint: the sidecar is the authority.
 */
export function databaseHint(env: NodeJS.ProcessEnv, channel: string, packaged: boolean) {
  const data = join(env.XDG_DATA_HOME || join(env.HOME || "~", ".local", "share"), "forge")
  const override = env.FORGE_DB
  if (override) {
    if (override === ":memory:" || isAbsolute(override)) return override
    return join(data, override)
  }
  // The desktop sets FORGE_DISABLE_CHANNEL_DB=1 for unpackaged builds, so an
  // unpackaged dev run lands on forge.db while packaged TurenOS Dev.app gets
  // forge-dev.db. That asymmetry is the thing this field exists to disambiguate.
  const disabled = !packaged || env.FORGE_DISABLE_CHANNEL_DB === "1" || env.FORGE_DISABLE_CHANNEL_DB === "true"
  if (disabled || ["latest", "beta", "prod"].includes(channel)) return join(data, "forge.db")
  return join(data, `forge-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

const BASE_NOTES = [
  "This is a V8 CPU profile of the TurenOS sidecar process only - the process that runs the agent loop, tool execution, the projector, compaction and MCP.",
  "It contains no renderer (UI) time, no Electron main-process time, and no GPU or network-service time. Do not look for UI jank here.",
  "Only the sidecar's main JavaScript thread is sampled.",
  "Native time (SQLite, node-pty, TLS) appears as (program) or GC frames with no JavaScript attribution.",
  "Work on the libuv threadpool (fs, crypto, zlib) and in spawned children (MCP servers, LSPs, ptys, forge-cli) is not sampled.",
  "Open the .cpuprofile in Chrome DevTools (Performance > Load profile) or at speedscope.app.",
]

export function buildManifest(input: {
  generated: Date
  armedMs: number
  sampleIntervalUs: number
  capture: ProfileCapture | null
  failure: string | null
  env: ProfilerEnvironment
  processEnv: NodeJS.ProcessEnv
}): ProfileManifest {
  const notes = [...BASE_NOTES]
  if (!input.capture) {
    notes.unshift(`WARNING: no profile was captured. ${input.failure ?? "The sidecar returned no data."}`)
  } else if (input.capture.samples === 0) {
    notes.unshift("WARNING: the profile contains zero samples and cannot be read as a profile.")
  }
  return {
    generated: input.generated.toISOString(),
    process: PROFILED_PROCESS,
    armedMs: input.armedMs,
    sampleIntervalUs: input.sampleIntervalUs,
    capture: input.capture,
    failure: input.failure,
    app: {
      ...input.env,
      databaseHint: databaseHint(input.processEnv, input.env.channel, input.env.packaged),
    },
    notes,
  }
}
