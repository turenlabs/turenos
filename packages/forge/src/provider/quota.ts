export * as ProviderQuota from "./quota"

import { Auth } from "@/auth"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Effect, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { ClaudeCodeProvider } from "./claude-code"
import type { Provider } from "./provider"
import { extractAccountId, refreshAccessToken } from "@/plugin/openai/codex"

/**
 * Reads one provider's account capacity without ever making the caller wait on
 * the provider.
 *
 * The Home dashboard asks every connected provider at once, and the slowest of
 * them sets the page's floor: an OAuth refresh plus a fetch, or a `claude -p`
 * process that costs ~1.4s every time. Serving the last known snapshot and
 * revalidating behind it keeps that cost off the request. A provider omitted
 * from the response renders as still loading and fills in on the client's
 * short cold-cache poll.
 */
export function snapshot(
  info: Provider.Info,
  auth: Auth.Info | undefined,
  save?: (auth: Auth.Info) => Effect.Effect<void, unknown>,
): Effect.Effect<Provider.Quota | undefined> {
  const entry = cache.get(info.id)
  if (entry === undefined || (entry.expiresAt <= Date.now() && entry.pending === undefined)) refresh(info, auth, save)
  if (entry?.value) return Effect.succeed(entry.value)
  return Effect.succeed(undefined)
}

const PROVIDER_CACHE_MS = 60 * 1_000
const CLI_CACHE_MS = 5 * 60 * 1_000
const RETRY_MS = 30 * 1_000

const cache = new Map<
  string,
  { value?: Provider.Quota; expiresAt: number; pending?: Promise<Provider.Quota | undefined> }
>()

function refresh(
  info: Provider.Info,
  auth: Auth.Info | undefined,
  save?: (auth: Auth.Info) => Effect.Effect<void, unknown>,
) {
  const previous = cache.get(info.id)?.value
  const pending = Effect.runPromise(load(info, auth, save))
    .catch(() => failed(info.id, info.id === ClaudeCodeProvider.ID ? "cli" : "provider"))
    .then((value) => {
      // A transient failure must never overwrite a good snapshot, and must never
      // be cached for as long as a success: the retry window is what lets a
      // provider that briefly 500s recover without the user reloading.
      const settled = value.status === "error" ? (previous ?? value) : value
      const ttl = value.status === "error" ? RETRY_MS : value.source === "cli" ? CLI_CACHE_MS : PROVIDER_CACHE_MS
      cache.set(info.id, { value: settled, expiresAt: Date.now() + ttl })
      return settled
    })
  cache.set(info.id, { value: previous, expiresAt: Date.now() + RETRY_MS, pending })
  return pending
}

export function load(
  info: Provider.Info,
  auth: Auth.Info | undefined,
  save?: (auth: Auth.Info) => Effect.Effect<void, unknown>,
): Effect.Effect<Provider.Quota> {
  if (info.id === "openai") {
    if (auth?.type !== "oauth")
      return Effect.succeed(unavailable(info.id, "provider", "API key limits are request-specific."))
    return Effect.gen(function* () {
      if (auth.expires > Date.now()) return auth
      const tokens = yield* Effect.tryPromise({ try: () => refreshAccessToken(auth.refresh), catch: (cause) => cause })
      const next = new Auth.Oauth({
        type: "oauth",
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + (tokens.expires_in ?? 3_600) * 1_000,
        accountId: extractAccountId(tokens) ?? auth.accountId,
      })
      if (save) yield* save(next)
      return next
    }).pipe(
      Effect.flatMap((current) =>
        request(
          info.id,
          ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/codex/usage"],
          {
            Authorization: `Bearer ${current.access}`,
            ...(current.accountId ? { "ChatGPT-Account-Id": current.accountId } : {}),
          },
          parseOpenAI,
        ),
      ),
      Effect.catch(() => Effect.succeed(failed(info.id, "provider"))),
    )
  }
  if (info.id === "kimi-for-coding") {
    const key = auth?.type === "api" ? auth.key : process.env.KIMI_API_KEY
    if (!key) return Effect.succeed(unavailable(info.id, "provider", "Kimi Code API key unavailable."))
    return request(info.id, ["https://api.kimi.com/coding/v1/usages"], { Authorization: `Bearer ${key}` }, parseKimi)
  }
  if (info.id === ClaudeCodeProvider.ID) return claude(info)
  return Effect.succeed(unavailable(info.id, "provider", "This provider does not expose account quota."))
}

function request(
  providerID: ProviderV2.ID,
  urls: ReadonlyArray<string>,
  headers: Record<string, string>,
  parse: (providerID: ProviderV2.ID, value: unknown) => Provider.Quota,
) {
  return Effect.tryPromise({
    try: async () => {
      return parse(providerID, await fetchFirst(urls, headers))
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(failed(providerID, "provider"))))
}

async function fetchFirst(urls: ReadonlyArray<string>, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(urls[0], { headers, signal: AbortSignal.timeout(5_000) })
  if (response.ok) return response.json()
  if (urls.length > 1) return fetchFirst(urls.slice(1), headers)
  throw new Error(`Quota request failed with status ${response.status}`)
}

export function parseOpenAI(providerID: ProviderV2.ID, value: unknown): Provider.Quota {
  const payload = record(value)
  const rateLimit = record(payload?.rate_limit)
  const windows = [
    percentWindow(rateLimit?.primary_window),
    percentWindow(rateLimit?.secondary_window),
    percentWindow(record(payload?.code_review_rate_limit)?.primary_window, "Code review"),
    ...array(payload?.additional_rate_limits).flatMap((item) => {
      const entry = record(item)
      const limit = record(entry?.rate_limit)
      const label = string(entry?.limit_name) ?? "Model limit"
      return [percentWindow(limit?.primary_window, label), percentWindow(limit?.secondary_window, label)]
    }),
  ].filter((window): window is Provider.QuotaWindow => window !== undefined)
  if (windows.length === 0) return failed(providerID, "provider")
  return {
    providerID,
    status: "available",
    source: "provider",
    plan: string(payload?.plan_type),
    windows,
  }
}

export function parseKimi(providerID: ProviderV2.ID, value: unknown): Provider.Quota {
  const payload = record(value)
  const windows = [
    usageWindow("Weekly limit", payload?.usage),
    ...array(payload?.limits).map((item, index) => {
      const entry = record(item)
      const detail = record(entry?.detail) ?? entry
      return usageWindow(limitLabel(entry, detail, index), detail)
    }),
  ].filter((window): window is Provider.QuotaWindow => window !== undefined)
  if (windows.length === 0) return failed(providerID, "provider")
  return { providerID, status: "available", source: "provider", windows }
}

export function parseClaude(providerID: ProviderV2.ID, stdout: string): Provider.Quota {
  const output = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(stdout)
  if (output._tag === "None") return failed(providerID, "cli")
  const text = string(record(output.value)?.result)
  if (!text) return failed(providerID, "cli")
  const windows = text.split("\n").flatMap((line) => {
    const match = /^(Current .+?):\s*([\d.]+)% used(?:\s*·\s*resets (.+))?$/.exec(line.trim())
    if (!match) return []
    return [{ label: match[1].replace(/^Current /, ""), usedPercent: percent(Number(match[2])), reset: match[3] }]
  })
  if (windows.length === 0) return failed(providerID, "cli")
  return { providerID, status: "available", source: "cli", plan: "Subscription", windows }
}

function claude(info: Provider.Info): Effect.Effect<Provider.Quota> {
  return Effect.promise(() =>
    runClaude(string(info.options.executable) ?? ClaudeCodeProvider.DEFAULT_EXECUTABLE)
      .then((stdout) => {
        // A snapshot that parsed to nothing is not a snapshot. Reporting it as
        // an error keeps the retry window short instead of caching an empty
        // success for five minutes.
        const value = parseClaude(info.id, stdout)
        return value.status === "available" ? value : failed(info.id, "cli")
      })
      .catch(() => failed(info.id, "cli")),
  )
}

const OUTPUT_LIMIT = 64 * 1024
const CLAUDE_TIMEOUT_MS = 5_000
/** `detached` puts the child in its own process group so teardown reaps grandchildren too. */
const GROUP_KILL = process.platform !== "win32"

/**
 * `node:child_process`, not `Bun.spawn`. The desktop app runs this server inside
 * an Electron `utilityProcess.fork`, which is plain Node -- `Bun` is undefined
 * there, so a Bun API throws on the first call and the whole Claude Code panel
 * silently reports "Current quota could not be loaded". See the import-boundary
 * test that keeps Bun APIs out of this package's runtime source.
 */
function runClaude(executable: string) {
  return new Promise<string>((resolve, reject) => {
    // batou:ignore injection -- `executable` is a `which`-resolved path from a
    // fixed default or operator config, and argv is an array, so no shell is
    // involved and nothing here is caller-supplied.
    const proc = spawn(
      executable,
      ["-p", "/usage", "--output-format", "json", "--tools", "", "--setting-sources", ""],
      {
        env: claudeEnvironment(),
        // stderr is discarded rather than piped: nothing reads it, and an
        // undrained pipe can block a child that writes more than its buffer.
        stdio: ["ignore", "pipe", "ignore"],
        detached: GROUP_KILL,
        windowsHide: true,
      },
    )
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const abort = (message: string) =>
      finish(() => {
        killProcess(proc)
        reject(new Error(message))
      })
    const timer = setTimeout(() => abort("Claude Code usage command timed out"), CLAUDE_TIMEOUT_MS)
    proc.on("error", () => finish(() => reject(new Error("Claude Code usage command failed"))))
    proc.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > OUTPUT_LIMIT) return abort("Claude Code usage output exceeded its limit")
      chunks.push(chunk)
    })
    // Buffers are concatenated before decoding so a multi-byte character split
    // across two chunks still decodes, which a per-chunk toString would corrupt.
    proc.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(Buffer.concat(chunks).toString("utf8"))
          : reject(new Error("Claude Code usage command failed")),
      ),
    )
  })
}

function claudeEnvironment() {
  const allowed = new Set([
    "ALL_PROXY",
    "APPDATA",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "SHELL",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "no_proxy",
  ])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name)))
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "forge"
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "forge"
  return env
}

function killProcess(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (!GROUP_KILL || proc.pid === undefined) {
    proc.kill("SIGKILL")
    return
  }
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill("SIGKILL")
  }
}

function percentWindow(value: unknown, name?: string): Provider.QuotaWindow | undefined {
  const data = record(value)
  const used = number(data?.used_percent)
  if (used === undefined) return undefined
  const reset = number(data?.reset_at)
  const seconds = number(data?.limit_window_seconds)
  const resetAt = reset === undefined ? undefined : safeInt(reset * 1_000, 8_640_000_000_000_000)
  const windowMinutes = seconds === undefined ? undefined : safeInt(seconds / 60)
  const duration = windowMinutes === undefined ? undefined : durationLabel(windowMinutes)
  return {
    label: name ? (duration ? `${name} · ${duration}` : name) : (duration ?? "Rate limit"),
    usedPercent: percent(used),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
  }
}

function durationLabel(minutes: number) {
  if (minutes === 10_080) return "Weekly window"
  if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}-day window`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

function usageWindow(label: string, value: unknown): Provider.QuotaWindow | undefined {
  const data = record(value)
  const limit = number(data?.limit)
  const remaining = number(data?.remaining)
  const used = number(data?.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
  if (limit === undefined || limit <= 0 || used === undefined) return undefined
  const reset = string(data?.reset_at) ?? string(data?.resetAt) ?? string(data?.reset_time) ?? string(data?.resetTime)
  const resetAt = reset === undefined ? undefined : safeInt(Date.parse(reset), 8_640_000_000_000_000)
  const resetIn = number(data?.reset_in) ?? number(data?.resetIn) ?? number(data?.ttl)
  return {
    label: string(data?.name) ?? string(data?.title) ?? label,
    usedPercent: percent((used / limit) * 100),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(resetIn === undefined ? {} : { reset: `in ${Math.max(0, Math.round(resetIn))}s` }),
  }
}

function limitLabel(
  entry: Record<string, unknown> | undefined,
  detail: Record<string, unknown> | undefined,
  index: number,
) {
  const named =
    string(entry?.name) ?? string(entry?.title) ?? string(entry?.scope) ?? string(detail?.name) ?? string(detail?.title)
  if (named) return named
  const window = record(entry?.window)
  const duration = number(window?.duration) ?? number(entry?.duration) ?? number(detail?.duration)
  const unit = string(window?.timeUnit) ?? string(entry?.timeUnit) ?? string(detail?.timeUnit)
  if (duration && unit?.includes("MINUTE"))
    return duration >= 60 && duration % 60 === 0 ? `${duration / 60}-hour limit` : `${duration}-minute limit`
  if (duration && unit?.includes("HOUR")) return `${duration}-hour limit`
  if (duration && unit?.includes("DAY")) return `${duration}-day limit`
  return `Rate window ${index + 1}`
}

function unavailable(providerID: ProviderV2.ID, source: Provider.Quota["source"], detail: string): Provider.Quota {
  return { providerID, status: "unavailable", source, detail, windows: [] }
}

function failed(providerID: ProviderV2.ID, source: Provider.Quota["source"]): Provider.Quota {
  return { providerID, status: "error", source, detail: "Current quota could not be loaded.", windows: [] }
}

function percent(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
}

function safeInt(value: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value < 0 || value > max) return undefined
  return Math.round(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : []
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function number(value: unknown) {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
