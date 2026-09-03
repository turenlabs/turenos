import path from "node:path"
import fs from "node:fs/promises"
import { Process } from "@/util/process"
import { ToolError, type Finding, type Severity } from "../types"

/**
 * Helpers for "tools" category integrations that wrap local scanner CLIs:
 * PATH detection, a subprocess runner with timeout + output caps, and SARIF /
 * JSON parse helpers that map results to the common `Finding` shape.
 *
 * Commands are always argv arrays executed without a shell; never build
 * command strings from user input.
 */

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Locate a binary on PATH. Returns the absolute path or undefined. */
export async function which(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (path.isAbsolute(bin)) {
    return (await isExecutable(bin)) ? bin : undefined
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

async function isExecutable(file: string) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    if (process.platform === "win32") return true
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a binary or throw a user-facing ToolError with an install hint. */
export async function requireBinary(bin: string, installHint?: string): Promise<string> {
  const found = await which(bin)
  if (found) return found
  throw new ToolError(
    `"${bin}" is not installed or not on PATH${installHint ? `. Install it with: ${installHint}` : ""}`,
  )
}

export interface RunOptions {
  cwd?: string
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>
  /** Abort the scanner from an owning request or durable cancellation monitor. */
  signal?: AbortSignal
  /** Observe bounded stdout chunks while preserving the normal captured result. */
  onStdout?: (chunk: string) => void
  /** Observe bounded stderr chunks, primarily for scanner progress. */
  onStderr?: (chunk: string) => void
  /** Wall-clock limit for the subprocess (default 120s). */
  timeoutMs?: number
  /** Cap per stream; excess output is discarded and flagged (default 8MB). */
  maxOutputBytes?: number
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
}

/**
 * Run a scanner CLI as `[command, ...args]` (no shell). Non-zero exit codes
 * are returned, not thrown — many scanners exit non-zero when they find
 * issues. Throws ToolError only when the process cannot be started.
 */
export async function run(command: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const started = Date.now()

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (opts.signal?.aborted) abort()
  opts.signal?.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let truncated = false
  const capture =
    (chunks: Buffer[], sizeRef: { size: number }, observe?: (chunk: string) => void) => (chunk: Buffer) => {
      observe?.(chunk.toString("utf8"))
      if (sizeRef.size >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - sizeRef.size
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        sizeRef.size = maxBytes
        truncated = true
        return
      }
      chunks.push(chunk)
      sizeRef.size += chunk.length
    }

  try {
    const child = Process.spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
      abort: controller.signal,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on("data", capture(stdout, { size: 0 }, opts.onStdout))
    child.stderr?.on("data", capture(stderr, { size: 0 }, opts.onStderr))

    const exitCode = await child.exited
    return {
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      timedOut,
      truncated,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    throw new ToolError(`failed to run "${command[0]}": ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", abort)
  }
}

/**
 * Tolerant JSON parse for CLI output: tries the whole text, then retries from
 * the first `{` or `[` (some tools print warnings before their JSON).
 */
export function parseJsonOutput<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    // fall through to a trimmed attempt
  }
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start)) as T
  } catch {
    return undefined
  }
}

// Minimal SARIF 2.1.0 shapes — only what parseSarif reads.
interface SarifLog {
  runs?: {
    tool?: { driver?: { name?: string; rules?: { id?: string; properties?: Record<string, unknown> }[] } }
    results?: {
      ruleId?: string
      level?: string
      message?: { text?: string }
      locations?: {
        physicalLocation?: {
          artifactLocation?: { uri?: string }
          region?: { startLine?: number; endLine?: number }
        }
      }[]
    }[]
  }[]
}

const LEVEL_SEVERITY: Record<string, Severity> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "info",
}

function securitySeverity(value: unknown): Severity | undefined {
  const score = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN
  if (!Number.isFinite(score)) return undefined
  if (score >= 9) return "critical"
  if (score >= 7) return "high"
  if (score >= 4) return "medium"
  if (score > 0) return "low"
  return "info"
}

/** Parse SARIF text (as emitted by trivy, checkov, opengrep, ...) into Findings. */
export function parseSarif(text: string): Finding[] {
  const log = parseJsonOutput<SarifLog>(text)
  if (!log?.runs) return []

  const findings: Finding[] = []
  for (const run of log.runs) {
    const tool = run.tool?.driver?.name
    const ruleSeverity = new Map<string, Severity>()
    for (const rule of run.tool?.driver?.rules ?? []) {
      const severity = securitySeverity(rule.properties?.["security-severity"])
      if (rule.id && severity) ruleSeverity.set(rule.id, severity)
    }
    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? "unknown"
      const location = result.locations?.[0]?.physicalLocation
      findings.push({
        ruleId,
        severity: ruleSeverity.get(ruleId) ?? LEVEL_SEVERITY[result.level ?? ""] ?? "unknown",
        message: result.message?.text ?? "",
        file: location?.artifactLocation?.uri,
        startLine: location?.region?.startLine,
        endLine: location?.region?.endLine,
        tool,
      })
    }
  }
  return findings
}

export * as Scanner from "./scanner"
