import type { Integration } from "../registry"
import { ToolError, type IntegrationContext, type Severity, type VulnRecord } from "../types"
import { fetchJson, HttpError } from "../util/http"

/**
 * GitHub Security Advisories (GHSA) — global advisory database.
 * API: https://api.github.com/advisories
 *
 * - GET /advisories/{ghsa_id}                       lookup by GHSA id
 * - GET /advisories?cve_id=CVE-...                  lookup by CVE id
 * - GET /advisories?ecosystem=...&affects=pkg[@ver] lookup by affected package
 *
 * Keyless: 60 req/hr. With a token (ctx.secrets.GITHUB_TOKEN, env
 * FORGE_SECURITY_GITHUB_TOKEN, sent as "Authorization: Bearer"): 5,000 req/hr.
 * Per-query responses are cached ~1h in ctx.cacheDir.
 *
 * Advisory data is CC-BY 4.0; every result carries the attribution string.
 */

const API = "https://api.github.com/advisories"
const CACHE_TTL_MS = 3_600_000 // ~1h, per CONVENTIONS.md for per-query APIs
const MAX_ADVISORIES = 30
const ATTRIBUTION = "GitHub Advisory Database (CC-BY 4.0)"

/** Map common ecosystem spellings to the GHSA API's ecosystem names. */
const GHSA_ECOSYSTEMS: Record<string, string> = {
  npm: "npm",
  node: "npm",
  pip: "pip",
  pypi: "pip",
  python: "pip",
  rubygems: "rubygems",
  gem: "rubygems",
  ruby: "rubygems",
  maven: "maven",
  nuget: "nuget",
  composer: "composer",
  packagist: "composer",
  php: "composer",
  go: "go",
  golang: "go",
  rust: "rust",
  "crates.io": "rust",
  crates: "rust",
  cargo: "rust",
  erlang: "erlang",
  hex: "erlang",
  actions: "actions",
  "github actions": "actions",
  pub: "pub",
  dart: "pub",
  swift: "swift",
  other: "other",
}

const VALID_ECOSYSTEMS = "npm, pip, rubygems, maven, nuget, composer, go, rust, erlang, actions, pub, swift, other"

interface GhsaAdvisory {
  ghsa_id: string
  cve_id?: string | null
  summary?: string
  description?: string | null
  severity?: string
  references?: string[]
  published_at?: string
  updated_at?: string
  vulnerabilities?: {
    package?: { ecosystem?: string; name?: string }
    vulnerable_version_range?: string | null
    first_patched_version?: string | null
  }[]
  cvss?: { vector_string?: string | null; score?: number | null } | null
  cwes?: { cwe_id?: string; name?: string }[]
}

/** VulnRecord plus the CWE ids GitHub attaches to advisories. */
type GhsaRecord = VulnRecord & { cwes?: string[] }

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 }

function mapSeverity(raw: string | undefined): Severity {
  const value = (raw ?? "").trim().toLowerCase()
  if (value === "critical") return "critical"
  if (value === "high") return "high"
  if (value === "medium" || value === "moderate") return "medium"
  if (value === "low") return "low"
  return "unknown"
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function mapAdvisory(advisory: GhsaAdvisory): GhsaRecord {
  const summary = clip(advisory.summary ?? advisory.description ?? "", 300)
  const affected = (advisory.vulnerabilities ?? []).slice(0, 10).map((vuln) => ({
    package: vuln.package?.name ?? "unknown",
    ...(vuln.package?.ecosystem ? { ecosystem: vuln.package.ecosystem } : {}),
    ...(vuln.vulnerable_version_range ? { ranges: [vuln.vulnerable_version_range] } : {}),
    ...(vuln.first_patched_version ? { fixed: vuln.first_patched_version } : {}),
  }))
  const references = (advisory.references ?? []).slice(0, 5)
  const cwes = (advisory.cwes ?? [])
    .map((cwe) => cwe.cwe_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 5)
  return {
    id: advisory.ghsa_id,
    source: "ghsa",
    severity: mapSeverity(advisory.severity),
    ...(advisory.cve_id ? { aliases: [advisory.cve_id] } : {}),
    ...(summary ? { summary } : {}),
    ...(typeof advisory.cvss?.score === "number" ? { cvss: advisory.cvss.score } : {}),
    ...(affected.length ? { affected } : {}),
    ...(references.length ? { references } : {}),
    ...(cwes.length ? { cwes } : {}),
    ...(advisory.updated_at ? { modified: advisory.updated_at } : {}),
  }
}

function headers(ctx: IntegrationContext): Record<string, string> {
  const token = ctx.secrets.GITHUB_TOKEN
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

function ghsaRequestError(error: unknown, hasToken: boolean): never {
  if (error instanceof HttpError) {
    if (error.status === 401) {
      throw new ToolError(
        "GitHub rejected the token (HTTP 401). Check FORGE_SECURITY_GITHUB_TOKEN, or unset it to use keyless access.",
      )
    }
    if (error.status === 403 || error.status === 429) {
      throw new ToolError(
        hasToken
          ? "GitHub API rate limit exceeded (HTTP 403/429). Wait for the limit to reset and retry."
          : "GitHub API rate limit exceeded (keyless access is 60 req/hr). Set FORGE_SECURITY_GITHUB_TOKEN to raise the limit to 5,000 req/hr.",
      )
    }
    if (error.status === 422) {
      throw new ToolError(`GitHub rejected the query parameters (HTTP 422). Valid ecosystems: ${VALID_ECOSYSTEMS}.`)
    }
    throw new ToolError(`GitHub advisories API request failed (HTTP ${error.status}); try again shortly`)
  }
  throw error
}

async function ghsaFetch<T>(url: string, ctx: IntegrationContext): Promise<T> {
  try {
    return await fetchJson<T>(url, {
      headers: headers(ctx),
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
    })
  } catch (error) {
    ghsaRequestError(error, Boolean(ctx.secrets.GITHUB_TOKEN))
  }
}

function listResult(query: Record<string, unknown>, advisories: GhsaAdvisory[]): unknown {
  const records = advisories
    .map(mapAdvisory)
    .sort((a, b) => SEVERITY_RANK[a.severity ?? "unknown"] - SEVERITY_RANK[b.severity ?? "unknown"])
  return {
    source: ATTRIBUTION,
    ...query,
    total: records.length,
    advisories: records.slice(0, MAX_ADVISORIES),
    ...(records.length > MAX_ADVISORIES
      ? { note: `showing top ${MAX_ADVISORIES} of ${records.length} by severity` }
      : {}),
  }
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

export const Ghsa: Integration = {
  id: "ghsa",
  category: "data",
  description: "Query the GitHub Security Advisory database (GHSA)",
  secrets: ["GITHUB_TOKEN"],
  tools: [
    {
      name: "ghsa_lookup",
      description:
        "Look up GitHub Security Advisories by GHSA id, CVE id, or affected package (ecosystem + name, " +
        "optionally at a specific version). Data: GitHub Advisory Database (CC-BY 4.0).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "GHSA id (GHSA-...) or CVE id (CVE-...)" },
          package: { type: "string", description: "Affected package name (requires ecosystem)" },
          ecosystem: {
            type: "string",
            description: `Affected ecosystem: ${VALID_ECOSYSTEMS}`,
          },
          version: { type: "string", description: "Package version to filter by (optional, with package)" },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = optionalString(args, "id")
        const pkg = optionalString(args, "package")
        const rawEcosystem = optionalString(args, "ecosystem")
        const version = optionalString(args, "version")

        if (id) {
          if (/^GHSA-/i.test(id)) {
            const advisory = await ghsaFetch<GhsaAdvisory>(`${API}/${encodeURIComponent(id.toUpperCase())}`, ctx)
            return { source: ATTRIBUTION, advisory: mapAdvisory(advisory) }
          }
          if (/^CVE-/i.test(id)) {
            const cveId = id.toUpperCase()
            const advisories = await ghsaFetch<GhsaAdvisory[]>(`${API}?cve_id=${encodeURIComponent(cveId)}`, ctx)
            return listResult({ cveId }, advisories)
          }
          throw new ToolError(`"id" must be a GHSA id (GHSA-...) or CVE id (CVE-...), got "${id}"`)
        }

        if (!pkg) {
          throw new ToolError('provide either "id" (GHSA-... or CVE-...) or "package" + "ecosystem"')
        }
        if (!rawEcosystem) {
          throw new ToolError(
            `"ecosystem" is required when looking up by package. Valid ecosystems: ${VALID_ECOSYSTEMS}.`,
          )
        }
        const ecosystem = GHSA_ECOSYSTEMS[rawEcosystem.toLowerCase()] ?? rawEcosystem.toLowerCase()
        const affects = version ? `${pkg}@${version}` : pkg
        const url = `${API}?ecosystem=${encodeURIComponent(ecosystem)}&affects=${encodeURIComponent(affects)}&per_page=50`
        const advisories = await ghsaFetch<GhsaAdvisory[]>(url, ctx)
        return listResult({ package: pkg, ecosystem, ...(version ? { version } : {}) }, advisories)
      },
    },
  ],
}
