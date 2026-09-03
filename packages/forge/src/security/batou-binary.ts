import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { errorMessage } from "@/util/error"
import { Scanner } from "./util/scanner"
import { securityCacheDir } from "./registry"

/**
 * Binary management for the bundled Batou SAST scanner.
 *
 * Resolution order: `batou` on PATH first, else a cached binary under
 * `<cache>/security/batou/batou`. When the integration is enabled and no
 * binary is found, the pinned release asset for the current platform is
 * downloaded, its SHA256 verified against the baked-in digest, made
 * executable, and atomically moved into place. All of this is best-effort:
 * unsupported platforms (Windows) and any download/verification failure are
 * reported as "not installed" and never throw — the caller fails open.
 */

/** Registry id and the FORGE_SECURITY_INTEGRATIONS token for Batou. */
export const BATOU_ID = "batou"

/** Pinned release. Bump alongside the checksums below. */
export const BATOU_VERSION = "v2.0.0"

/**
 * Lifecycle of the managed Batou binary, surfaced to the settings UI:
 *  - "not-installed": no binary present and nothing in flight.
 *  - "downloading":   a download is currently running (single-flight).
 *  - "installed":     a usable binary is resolvable (PATH or cache dir).
 *  - "failed":        the last download failed and we're inside the backoff.
 */
export type BatouStatus = "not-installed" | "downloading" | "installed" | "failed"

export interface BatouStatusInfo {
  status: BatouStatus
  /** Version when installed; a short, sanitized reason when failed. Never a URL/path. */
  detail?: string
}

type BatouOs = "darwin" | "linux"
type BatouArch = "amd64" | "arm64"

/** SHA256 of each release asset, keyed by `${os}-${arch}`. */
const CHECKSUMS: Record<string, string> = {
  "darwin-arm64": "6f31c771d5badb0183c10aaddad76308abac9f9342dfc77283f5c2c035c694d4",
  "darwin-amd64": "30ad638755eb84ff73d86a3a89713cdd6cf8614fe6ad17632a130d5436ef98d3",
  "linux-arm64": "bb17524336f5923efe5c31066e14abb8695ceaaa10f65919c6e9063099f3ba37",
  "linux-amd64": "f205cba949d0cc545c5ea4f91622d125d715188782218293ec96f4b3164ba5c4",
}

/** Re-download backoff after a failure, so a broken network doesn't hammer GitHub. */
const FAILURE_BACKOFF_MS = 60_000

export interface BatouPlatform {
  os: BatouOs
  arch: BatouArch
}

/** Map a Node platform/arch to a Batou release target, or undefined if unsupported. */
export function batouPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BatouPlatform | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined
  if (!os || !cpu) return undefined
  return { os, arch: cpu }
}

/** Directory that holds the cached Batou binary. */
export function batouCacheDir(): string {
  return path.join(securityCacheDir(), BATOU_ID)
}

/** Absolute path of the cached Batou binary. */
export function batouBinaryPath(): string {
  return path.join(batouCacheDir(), "batou")
}

/** Download URL of the release asset for a platform. */
export function batouDownloadUrl(target: BatouPlatform): string {
  return `https://github.com/turenlabs/batou/releases/download/${BATOU_VERSION}/batou-${target.os}-${target.arch}`
}

async function isExecutableFile(file: string): Promise<boolean> {
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

/** Resolve an existing Batou binary: PATH first, then the cached copy. */
export async function resolveBatouBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const onPath = await Scanner.which(BATOU_ID, env)
  if (onPath) return onPath
  const cached = batouBinaryPath()
  if (await isExecutableFile(cached)) return cached
  return undefined
}

/**
 * Whether a usable Batou binary is present (PATH or cache dir). Powers the
 * `installed` flag surfaced by GET /global/security/integrations.
 */
export async function batouInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await resolveBatouBinary(env)) !== undefined
}

export interface EnsureBatouOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  logger?: (message: string) => void
}

let inflight: Promise<string | undefined> | undefined
let failedUntil = 0
/** Sanitized summary of the most recent download failure (no URLs/paths). */
let lastFailure: string | undefined

/**
 * Report the lifecycle status of the managed Batou binary for the settings UI.
 * "installed" wins whenever a usable binary resolves; otherwise an inflight
 * download reads as "downloading", a recent failure (within the backoff) as
 * "failed" with a sanitized reason, and everything else as "not-installed".
 */
export async function batouStatus(env: NodeJS.ProcessEnv = process.env): Promise<BatouStatusInfo> {
  if (await resolveBatouBinary(env)) return { status: "installed", detail: BATOU_VERSION }
  if (inflight) return { status: "downloading" }
  if (Date.now() < failedUntil) return { status: "failed", ...(lastFailure ? { detail: lastFailure } : {}) }
  return { status: "not-installed" }
}

/**
 * Start (or join) the single-flight download for the current platform. Sets the
 * `inflight` marker synchronously so `batouStatus()` reports "downloading" the
 * moment this returns. Returns undefined (never throws) on unsupported
 * platforms or while inside the failure backoff.
 */
function startDownload(opts: EnsureBatouOptions): Promise<string | undefined> {
  const target = batouPlatform(opts.platform ?? process.platform, opts.arch ?? process.arch)
  if (!target) return Promise.resolve(undefined) // Windows / unsupported → installed:false semantics.

  if (Date.now() < failedUntil) return Promise.resolve(undefined)
  if (inflight) return inflight

  lastFailure = undefined
  const run = (async () => {
    try {
      return await downloadBatou(target, opts)
    } catch (error) {
      lastFailure = downloadFailureSummary(error)
      opts.logger?.(`batou download failed: ${errorMessage(error)}`)
      return undefined
    }
  })()
  inflight = run
  void run
    .then((result) => {
      if (!result) failedUntil = Date.now() + FAILURE_BACKOFF_MS
    })
    .finally(() => {
      if (inflight === run) inflight = undefined
    })
  return run
}

/**
 * Resolve a Batou binary, downloading the pinned release on first use when
 * none is present. Single-flight: concurrent callers share one download.
 * Returns undefined (never throws) on unsupported platforms or any failure,
 * with a short backoff so a persistent failure doesn't re-download per write.
 */
export async function ensureBatouBinary(opts: EnsureBatouOptions = {}): Promise<string | undefined> {
  const existing = await resolveBatouBinary(opts.env)
  if (existing) return existing
  return startDownload(opts)
}

/**
 * Fire-and-forget download kickoff for the settings enable path. Callers that
 * have already established the binary is missing use this so the very next
 * `batouStatus()` reports "downloading" without waiting on the filesystem probe
 * `ensureBatouBinary` does first. An explicit (re)enable is a deliberate retry
 * signal, so it clears any prior failure backoff. Single-flight still dedupes.
 */
export function beginBatouDownload(opts: EnsureBatouOptions = {}): void {
  failedUntil = 0
  void startDownload(opts)
}

/**
 * A download failure that carries a UI-safe `summary` alongside the detailed
 * `message`. The summary is surfaced to users via `batouStatus()` and must
 * never contain a URL or filesystem path; the message is for logs only.
 */
class BatouDownloadError extends Error {
  constructor(
    message: string,
    readonly summary: string,
  ) {
    super(message)
    this.name = "BatouDownloadError"
  }
}

/** Sanitized failure reason for the UI. Falls back to a generic message so an
 *  arbitrary error (which may embed a path) never leaks through. */
function downloadFailureSummary(error: unknown): string {
  return error instanceof BatouDownloadError ? error.summary : "download failed"
}

async function downloadBatou(target: BatouPlatform, opts: EnsureBatouOptions): Promise<string | undefined> {
  const expected = CHECKSUMS[`${target.os}-${target.arch}`]
  if (!expected) return undefined

  const url = batouDownloadUrl(target)
  const fetchImpl = opts.fetchImpl ?? fetch
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new BatouDownloadError(
      `unexpected status ${response.status} for ${url}`,
      `download failed (HTTP ${response.status})`,
    )
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = crypto.createHash("sha256").update(bytes).digest("hex")
  if (digest !== expected) {
    // Verify before writing anything, so a mismatch leaves nothing behind.
    throw new BatouDownloadError(
      `checksum mismatch for ${url}: expected ${expected}, got ${digest}`,
      "checksum verification failed",
    )
  }

  const dir = batouCacheDir()
  await fs.mkdir(dir, { recursive: true })
  const finalPath = batouBinaryPath()
  const tmpPath = path.join(dir, `.batou.download-${process.pid}-${Date.now()}`)
  try {
    await fs.writeFile(tmpPath, bytes, { mode: 0o700 })
    await fs.chmod(tmpPath, 0o700)
    await fs.rename(tmpPath, finalPath) // atomic within the same directory
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
  return finalPath
}

/** Test-only: reset the single-flight/backoff/status state between cases. */
export function resetBatouDownloadState(): void {
  inflight = undefined
  failedUntil = 0
  lastFailure = undefined
}
