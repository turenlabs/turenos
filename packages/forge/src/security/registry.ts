import path from "node:path"
import { Global } from "@turenlabs/core/global"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Effect } from "effect"
import type { IntegrationContext, ToolDef } from "./types"
import { Osv } from "./integrations/osv"
import { DepsDev } from "./integrations/depsdev"
import { Kev } from "./integrations/kev"
import { Epss } from "./integrations/epss"
import { Ghsa } from "./integrations/ghsa"
import { Hibp } from "./integrations/hibp"
import { ExploitDb } from "./integrations/exploitdb"
import { Nvd } from "./integrations/nvd"
import { Attack } from "./integrations/data-knowledge/attack"
import { Cwe } from "./integrations/data-knowledge/cwe"
import { D3fend } from "./integrations/data-knowledge/d3fend"
import { Capec } from "./integrations/data-knowledge/capec"
import { CirclHashlookup } from "./integrations/data-ioc/circl-hashlookup"
import { Euvd } from "./integrations/data-community/euvd"
import { Lolbas } from "./integrations/data-community/lolbas"
import { Gtfobins } from "./integrations/data-community/gtfobins"
import { Scorecard } from "./integrations/data-community/scorecard"
import { CertFrMisp } from "./integrations/data-certfr/certfr-misp"
import { DatadogMalicious } from "./integrations/data-supply/datadog-malicious"
import { PhishingDatabase } from "./integrations/data-ti-open/phishing-database"
import { TorExit } from "./integrations/data-ti-open/tor-exit"
import { TweetFeed } from "./integrations/data-ti-open/tweetfeed"
import { Gitleaks } from "./integrations/gitleaks"
import { Trivy } from "./integrations/trivy"
import { OsvScanner } from "./integrations/osv-scanner"
import { Grype } from "./integrations/grype"
import { Checkov } from "./integrations/checkov"
import { Bandit } from "./integrations/bandit"
import { NativeAudit } from "./integrations/native-audit"
import { Opengrep } from "./integrations/opengrep"
import { Batou } from "./integrations/batou"
import { Linear } from "./integrations/linear"

/**
 * Finer-grained axis within category:"tools", used to group the tools surface
 * into sections. Has no bearing on category:"data" integrations. Add a new
 * member here (and give it a label in en.ts under settings.security.group.*)
 * when a tool genuinely doesn't fit an existing bucket -- do not stretch an
 * existing one to cover it.
 */
export type IntegrationGroup =
  | "sast" // static analysis over source code
  | "dependencies" // dependency / SBOM / supply-chain vulnerability scanning
  | "secrets" // secret detection
  | "iac" // infrastructure-as-code misconfiguration scanning

/**
 * The contract every module in `integrations/` implements. See CONVENTIONS.md
 * for the full rules (output shape, caching, secrets, error handling).
 */
export interface Integration {
  /** Stable id, as used in FORGE_SECURITY_INTEGRATIONS. */
  id: string
  /** Security integrations and agent-facing data/tool integrations share one managed MCP process. */
  category: "data" | "tools" | "agent-data" | "agent-tools"
  /**
   * Sub-category within category:"tools" for the settings UI (see
   * IntegrationGroup). Optional — a "tools" integration without one still
   * renders, just under a catch-all "Other" section rather than disappearing.
   */
  group?: IntegrationGroup
  /** One-line description surfaced in the MCP server instructions. */
  description: string
  /** Detailed usage guidance from the owning Extension manifest. */
  instructions?: string
  /**
   * Secret names this integration reads from ctx.secrets (documentation +
   * discoverability). Each maps to env var FORGE_SECURITY_<NAME>.
   */
  secrets?: string[]
  /** External host executables selected directly by this audited adapter. */
  executables?: readonly string[]
  tools: ToolDef[]
}

/** All known integrations. Order determines listing order. */
const implementations: readonly Integration[] = [
  // data
  Osv,
  DepsDev,
  Kev,
  Epss,
  Ghsa,
  Hibp,
  ExploitDb,
  Nvd,
  Attack,
  Cwe,
  D3fend,
  Capec,
  CirclHashlookup,
  Euvd,
  Lolbas,
  Gtfobins,
  Scorecard,
  CertFrMisp,
  DatadogMalicious,
  PhishingDatabase,
  TorExit,
  TweetFeed,
  // agent integrations
  Linear,
  // tools
  Gitleaks,
  Trivy,
  OsvScanner,
  Grype,
  Checkov,
  Bandit,
  NativeAudit,
  Opengrep,
  Batou,
]

/** Runtime implementations projected through the Extension v1 catalog. */
export const INTEGRATIONS: readonly Integration[] = implementations.map((runtime) => {
  const contribution = ExtensionCatalog.contribution(`security:${runtime.id}`)
  if (!contribution) throw new Error(`Missing Extension v1 contribution for security adapter: ${runtime.id}`)
  if (contribution.type !== "tool" && contribution.type !== "data" && contribution.type !== "mcp") {
    throw new Error(`Unsupported Extension v1 contribution for security adapter: ${runtime.id}`)
  }
  const declared = contribution.type === "tool" ? [...contribution.commands].toSorted() : []
  const implemented = [...(runtime.executables ?? [])].toSorted()
  if (declared.length !== implemented.length || declared.some((command, index) => command !== implemented[index])) {
    throw new Error(`Extension executable declarations do not match security adapter: ${runtime.id}`)
  }
  if (
    JSON.stringify(contribution.tools.allow.toSorted()) !==
    JSON.stringify(runtime.tools.map((tool) => tool.name).toSorted())
  ) {
    throw new Error(`Extension tool declarations do not match security adapter: ${runtime.id}`)
  }
  return {
    ...runtime,
    category: contribution.type === "data" ? "data" : contribution.type === "mcp" ? "agent-tools" : "tools",
    description: contribution.description,
    instructions: contribution.instructions,
    secrets: contribution.secrets.map((item) => item.id),
    ...(contribution.type === "tool" && contribution.group ? { group: contribution.group as IntegrationGroup } : {}),
  }
})

/** Comma-separated integration ids; unset or "all" enables everything. */
export const INTEGRATIONS_ENV = "FORGE_SECURITY_INTEGRATIONS"

/** Prefix for secret env vars, e.g. FORGE_SECURITY_NVD_KEY -> secrets.NVD_KEY. */
export const SECRET_ENV_PREFIX = "FORGE_SECURITY_"

export function integration(id: string): Integration | undefined {
  return INTEGRATIONS.find((entry) => entry.id === id)
}

export function extensionID(integrationID: string) {
  const manifest = ExtensionCatalog.forAdapter(`security:${integrationID}`)
  if (!manifest) throw new Error(`Missing Extension for security adapter: ${integrationID}`)
  return manifest.id
}

export const configurationFor = Effect.fn("SecurityRegistry.configurationFor")(function* (integrationID: string) {
  const extensions = yield* ExtensionRuntime.Service
  return yield* extensions.configuration(extensionID(integrationID))
})

export const credentialsFor = Effect.fn("SecurityRegistry.credentialsFor")(function* (integration: Integration) {
  const extensions = yield* ExtensionRuntime.Service
  const values = yield* Effect.forEach(integration.secrets ?? [], (name) =>
    extensions.secret(extensionID(integration.id), name).pipe(Effect.map((value) => [name, value] as const)),
  )
  return Object.fromEntries(values.filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
})

export const secretsSetFor = Effect.fn("SecurityRegistry.secretsSetFor")(function* (integration: Integration) {
  const extensions = yield* ExtensionRuntime.Service
  return yield* extensions.secretsSet(extensionID(integration.id))
})

export const spawnEnvironment = Effect.fn("SecurityRegistry.spawnEnvironment")(function* (
  selected: ReadonlySet<string>,
) {
  const environment: Record<string, string> = { [INTEGRATIONS_ENV]: [...selected].join(",") }
  for (const integration of INTEGRATIONS) {
    if (!selected.has(integration.id)) continue
    for (const [name, value] of Object.entries(yield* credentialsFor(integration))) {
      environment[SECRET_ENV_PREFIX + name] = value
    }
  }
  return environment
})

const secretValues = Effect.fnUntraced(function* () {
  const values = yield* Effect.forEach(INTEGRATIONS, (integration) =>
    credentialsFor(integration).pipe(Effect.map((credentials) => Object.values(credentials))),
  )
  return [...new Set(values.flat())].sort((left, right) => right.length - left.length)
})

export const redactValue = Effect.fn("SecurityRegistry.redactValue")(function* (value: unknown) {
  return redactUnknown(value, yield* secretValues())
})

function redactUnknown(value: unknown, secrets: ReadonlyArray<string>): unknown {
  if (typeof value === "string") {
    return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item, secrets)]))
}

/**
 * Resolve the enabled integrations from FORGE_SECURITY_INTEGRATIONS.
 * Unset or "all" -> every integration; empty string -> none. Unknown ids are
 * reported via `onUnknown` (the server logs them to stderr) and skipped.
 */
export function enabledIntegrations(
  env: Record<string, string | undefined> = process.env,
  onUnknown?: (id: string) => void,
): Integration[] {
  const raw = env[INTEGRATIONS_ENV]
  if (raw === undefined || raw.trim() === "all") return [...INTEGRATIONS]

  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)

  const result: Integration[] = []
  for (const id of ids) {
    const found = integration(id)
    if (!found) {
      onUnknown?.(id)
      continue
    }
    if (!result.includes(found)) result.push(found)
  }
  return result
}

/** Collect FORGE_SECURITY_* secrets from the environment, prefix stripped. */
export function secretsFromEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith(SECRET_ENV_PREFIX) || key === INTEGRATIONS_ENV) continue
    secrets[key.slice(SECRET_ENV_PREFIX.length)] = value
  }
  return secrets
}

/** Root of the on-disk cache shared by all integrations. */
export function securityCacheDir(): string {
  return path.join(Global.Path.cache, "security")
}

/** Build the per-integration context handed to every tool handler. */
export function makeContext(
  target: Integration,
  env: Record<string, string | undefined> = process.env,
  workspace: string = process.cwd(),
): IntegrationContext {
  const available = secretsFromEnv(env)
  return {
    workspace,
    cacheDir: path.join(securityCacheDir(), target.id),
    secrets: Object.fromEntries(
      (target.secrets ?? []).flatMap((name) => (available[name] ? [[name, available[name]]] : [])),
    ),
  }
}

export * as SecurityRegistry from "./registry"
