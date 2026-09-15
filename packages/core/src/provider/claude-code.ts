export * as ClaudeCodeCLI from "./claude-code"

import { spawn } from "node:child_process"
import { ProviderV2 } from "../provider"
import { which } from "../util/which"

/**
 * Claude Code (local) — a subscription-backed provider whose transport is the
 * `claude` CLI rather than an HTTP endpoint. It has no stored credential and no
 * `auth.json` entry by design: the only source of truth for "can this run" is a
 * live probe of the binary (`claude auth status --json`).
 */
export const ID = ProviderV2.ID.make("claude-code")
export const NAME = "Claude Code (local)"

/**
 * Sentinel `api.url` marking a model that runs through the local CLI transport
 * instead of an HTTP route. `ProviderV2.Api` only models `aisdk | native`, so
 * this pseudo-URL is how a native entry declares "spawn, don't fetch".
 */
export const API_URL = "local://claude-code"
export const DEFAULT_EXECUTABLE = "claude"

const PROBE_TIMEOUT = 5_000
const PROBE_OUTPUT_LIMIT = 64 * 1024

export type ProbeResult =
  | { readonly status: "authenticated"; readonly executable: string }
  | { readonly status: "unauthenticated"; readonly executable: string }
  | { readonly status: "unavailable" }

/**
 * A Claude Code subscription is the only credential source for this provider.
 * Strip ambient credentials and provider routing so this provider can only use
 * Claude Code's local subscription login. Preserve corporate proxies for the
 * Anthropic request, but force the private TurenOS MCP server around them.
 */
export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !name.startsWith("ANTHROPIC_") &&
        !name.startsWith("CLAUDE_CODE_USE_") &&
        name !== "CLAUDE_CODE_API_BASE_URL" &&
        name !== "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  )
  const noProxy = [
    ...(env.NO_PROXY ?? "").split(","),
    ...(env.no_proxy ?? "").split(","),
    "localhost",
    "127.0.0.1",
    "::1",
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "forge"
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "forge"
  env.MCP_TOOL_TIMEOUT = "610000"
  env.NO_PROXY = [...new Set(noProxy)].join(",")
  env.no_proxy = env.NO_PROXY
  return env
}

export function resolveExecutable(value: unknown): string | undefined {
  const requested = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_EXECUTABLE
  return which(requested) ?? undefined
}

/**
 * Live connectedness probe. Never throws — an unusable CLI is a status, not a
 * failure, because the catalog has to keep working without Claude Code.
 */
export async function probe(value?: unknown): Promise<ProbeResult> {
  const executable = resolveExecutable(value)
  if (!executable) return { status: "unavailable" }
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let stdout = ""
    let size = 0
    // batou:ignore injection -- `executable` is resolved through `which` from a
    // fixed default or operator-configured command name, and the argv is a
    // constant array passed without a shell.
    const child = spawn(executable, ["auth", "status", "--json"], {
      env: subscriptionEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done({ status: "unavailable" })
    }, PROBE_TIMEOUT)
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > PROBE_OUTPUT_LIMIT) {
        child.kill("SIGKILL")
        done({ status: "unavailable" })
        return
      }
      stdout += chunk.toString("utf8")
    })
    child.stdout?.on("error", () => done({ status: "unavailable" }))
    child.stderr?.resume()
    child.stderr?.on("error", () => done({ status: "unavailable" }))
    child.on("error", () => done({ status: "unavailable" }))
    child.on("close", (code) => {
      if (code !== 0) return done({ status: "unauthenticated", executable })
      try {
        const parsed: unknown = JSON.parse(stdout)
        const loggedIn =
          typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).loggedIn === true
        done(loggedIn ? { status: "authenticated", executable } : { status: "unauthenticated", executable })
      } catch {
        done({ status: "unauthenticated", executable })
      }
    })
  }).catch(() => ({ status: "unavailable" }))
}

/**
 * `claude --effort <level>`. The CLI accepts exactly these five names and warns
 * then falls back to its own default for anything else, so this is also the
 * variant vocabulary TurenOS publishes for the provider — no translation layer.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Guards the value that reaches argv. A variant id is sticky session state and
 * `request.body` is also reachable from user config, so neither is trusted to
 * already name a level the CLI understands.
 */
export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(value)

export type ModelDefinition = {
  readonly id: string
  readonly apiID: string
  readonly name: string
  readonly family: string
  /** Offline fallback only. The real window comes from the catalog — see `windowFor`. */
  readonly context: number
  /** Offline fallback only. The real window comes from the catalog — see `windowFor`. */
  readonly output: number
  /** Levels this model accepts for `--effort`; empty means the flag is never passed. */
  readonly efforts: ReadonlyArray<EffortLevel>
}

/** Catalog provider whose entries describe the models the CLI actually serves. */
export const CATALOG_PROVIDER = "anthropic"

export type Window = { readonly context: number; readonly output: number }

/** A catalog entry reduced to just what window resolution needs. */
export type CatalogEntry = {
  readonly family: string | undefined
  /** Epoch millis, or any monotonic release ordering. Newest wins. */
  readonly released: number
  readonly limit: Window
}

/**
 * Newest catalog entry per family.
 *
 * The CLI's `opus`/`sonnet`/`haiku` aliases are *floating* — they resolve
 * against Claude Code's own bundled catalog to whatever the current generation
 * of that family is, and they move on their own schedule. Keying on family and
 * taking the newest release therefore tracks the alias without pinning a model
 * id that would go stale the next time a generation ships. Pinning ids is
 * exactly how this table came to claim 200k for Opus long after Opus grew to
 * 1M.
 */
export const windowsByFamily = (entries: Iterable<CatalogEntry>): ReadonlyMap<string, Window> => {
  const best = new Map<string, { released: number; limit: Window }>()
  for (const entry of entries) {
    if (entry.family === undefined) continue
    if (entry.limit.context <= 0) continue
    const current = best.get(entry.family)
    if (current && current.released >= entry.released) continue
    best.set(entry.family, { released: entry.released, limit: entry.limit })
  }
  return new Map([...best].map(([family, item]) => [family, item.limit]))
}

/** A catalog entry reduced to what pinned-generation seeding needs. */
export type PinnedEntry = CatalogEntry & {
  readonly id: string
  readonly name?: string
  readonly status?: string
}

export type PinnedModel = ModelDefinition & {
  /** Epoch millis from the upstream catalog; drives release ordering in the picker. */
  readonly released: number
}

/**
 * A dated deployment id (`claude-opus-4-5-20251101`) names the same generation
 * as the undated id the CLI accepts; seeding both would offer two rows for one
 * model.
 */
const DATED_DEPLOYMENT = /-\d{8}$/

/**
 * Fixed-generation entries mirrored from the anthropic catalog.
 *
 * The aliases in `MODELS` float to whatever generation the installed CLI
 * currently ships, so there is otherwise no way to keep an older generation —
 * or to disable a specific one — once the float moves on. A pinned entry
 * passes its own id to `--model` and is enabled/disabled independently of the
 * alias.
 *
 * Effort variants follow the alias contract: only the newest catalog entry per
 * family is known to accept `--effort`, so older generations publish none and
 * run at the CLI default.
 */
export const pinnedModels = (entries: Iterable<PinnedEntry>): ReadonlyArray<PinnedModel> => {
  const served = new Map(MODELS.map((item) => [item.family, item]))
  const candidates = Array.from(entries).flatMap((entry) => {
    const family = entry.family
    if (family === undefined) return []
    const alias = served.get(family)
    if (alias === undefined) return []
    if (entry.status !== undefined && entry.status !== "active") return []
    if (entry.limit.context <= 0 || DATED_DEPLOYMENT.test(entry.id)) return []
    return [{ entry, family, alias }]
  })
  const newest = new Map<string, number>()
  for (const { entry, family } of candidates) {
    const current = newest.get(family)
    if (current === undefined || entry.released > current) newest.set(family, entry.released)
  }
  return candidates
    .map(({ entry, family, alias }): PinnedModel => ({
      id: entry.id,
      apiID: entry.id,
      name: entry.name ?? entry.id,
      family,
      context: entry.limit.context,
      output: entry.limit.output,
      released: entry.released,
      efforts: entry.released === newest.get(family) ? alias.efforts : [],
    }))
    .sort((a, b) => b.released - a.released)
}

/**
 * The window TurenOS should report and budget against for a CLI model.
 *
 * Falls back to the static table only when the catalog has nothing to say —
 * a packaged build with no snapshot, or a family the catalog has not published
 * yet. A stale-but-present catalog is still a better answer than a constant.
 */
export const windowFor = (item: ModelDefinition, byFamily?: ReadonlyMap<string, Window>): Window =>
  byFamily?.get(item.family) ?? { context: item.context, output: item.output }

/**
 * Single source of truth for both catalogs — `packages/forge/src/provider/claude-code.ts`
 * builds the v1 snapshot the composer reads from this same list, so the model
 * ids and variant ids the UI offers cannot drift from the ones the v2 runner
 * can actually honour.
 *
 * Cost is zero everywhere because the turn is billed against the user's Claude
 * subscription, not per-token API pricing — showing API rates would be a lie.
 *
 * Effort support is per model, not per provider. The CLI resolves these aliases
 * against its own bundled catalog (`fable` -> Fable 5.1, `opus` -> Opus 5,
 * `sonnet` -> Sonnet 5) and
 * gates `--effort` on a model capability; the current Fable/Opus/Sonnet
 * generations carry the full `effort`/`max_effort`/`xhigh_effort` set, while
 * Haiku 4.5 carries none and is refused the flag outright. Offering levels a
 * model cannot honour would just silently do nothing.
 */
export const MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "fable",
    apiID: "fable",
    name: "Claude Fable",
    family: "claude-fable",
    context: 1_000_000,
    output: 128_000,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "sonnet",
    apiID: "sonnet",
    name: "Claude Sonnet",
    family: "claude-sonnet",
    context: 200_000,
    output: 64_000,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "opus",
    apiID: "opus",
    name: "Claude Opus",
    family: "claude-opus",
    context: 200_000,
    output: 64_000,
    efforts: EFFORT_LEVELS,
  },
  {
    id: "haiku",
    apiID: "haiku",
    name: "Claude Haiku",
    family: "claude-haiku",
    context: 200_000,
    output: 64_000,
    efforts: [],
  },
]

/** Request-body keys the catalog carries from the provider down to the transport. */
export const EXECUTABLE_KEY = "executable"
export const DIRECTORY_KEY = "directory"
/** Carries the selected variant's effort level from the catalog to the CLI argv. */
export const EFFORT_KEY = "effort"
