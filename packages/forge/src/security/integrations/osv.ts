import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../registry"
import { ToolError, type IntegrationContext, type Severity, type VulnRecord } from "../types"
import { fetchJson, HttpError } from "../util/http"

/**
 * OSV.dev — Open Source Vulnerabilities database.
 * API: https://google.github.io/osv.dev/api/ (no key, no rate limits)
 *
 * - POST /v1/query        single package (+ optional version) -> full records
 * - POST /v1/querybatch   many packages at once -> vuln ids only
 * - GET  /v1/vulns/{id}   full record by OSV id (GHSA-..., CVE-..., ...)
 *
 * Per-query responses are cached ~1h in ctx.cacheDir (CONVENTIONS.md). Records
 * are trimmed to agent-relevant fields and capped so results stay well under
 * the 50KB serialization limit.
 */

const API = ExtensionCatalog.dataEndpoint("security:osv")
const CACHE_TTL_MS = 3_600_000 // ~1h, per CONVENTIONS.md for per-query APIs
const MAX_RECORDS = 50
const MAX_BATCH_QUERIES = 100
const MAX_IDS_PER_BATCH_RESULT = 50

/** Map common ecosystem spellings to OSV's case-sensitive ecosystem names. */
const OSV_ECOSYSTEMS: Record<string, string> = {
  npm: "npm",
  node: "npm",
  pypi: "PyPI",
  pip: "PyPI",
  python: "PyPI",
  go: "Go",
  golang: "Go",
  "crates.io": "crates.io",
  crates: "crates.io",
  cargo: "crates.io",
  rust: "crates.io",
  maven: "Maven",
  nuget: "NuGet",
  packagist: "Packagist",
  composer: "Packagist",
  php: "Packagist",
  rubygems: "RubyGems",
  gem: "RubyGems",
  ruby: "RubyGems",
  hex: "Hex",
  pub: "Pub",
  dart: "Pub",
  debian: "Debian",
  alpine: "Alpine",
  actions: "GitHub Actions",
  "github actions": "GitHub Actions",
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string }
  ranges?: { type?: string; events?: Record<string, string>[] }[]
  ecosystem_specific?: { severity?: string }
  database_specific?: {
    severity?: string
    source?: string
    indicators?: { evidence_files?: { path?: string; sha256?: string; tlsh?: string }[] }
  }
}

interface OsvDatabaseSpecific {
  severity?: string
  iocs?: { files?: { paths?: string[]; sha256?: string; note?: string }[] }
  "malicious-packages-origins"?: { source?: string; id?: string; versions?: string[]; sha256?: string }[]
}

export interface OsvVuln {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  published?: string
  modified?: string
  severity?: { type?: string; score?: string }[]
  database_specific?: OsvDatabaseSpecific
  affected?: OsvAffected[]
  references?: { type?: string; url?: string }[]
}

interface OsvQueryResponse {
  vulns?: OsvVuln[]
  next_page_token?: string
}

interface OsvBatchResponse {
  results?: { vulns?: { id: string; modified?: string }[]; next_page_token?: string }[]
}

type OsvRecord = VulnRecord & {
  classification?: "malicious-package"
  maliciousOrigins?: { source?: string; id?: string; versions?: string[]; sha256?: string }[]
  evidenceFiles?: { path: string; sha256?: string; tlsh?: string; note?: string }[]
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 }

function normalizeSeverity(raw: string | undefined): Severity | undefined {
  if (!raw) return undefined
  const value = raw.trim().toLowerCase()
  if (value === "critical") return "critical"
  if (value === "high") return "high"
  if (value === "medium" || value === "moderate") return "medium"
  if (value === "low") return "low"
  return undefined
}

function osvSeverity(vuln: OsvVuln): Severity {
  const direct = normalizeSeverity(vuln.database_specific?.severity)
  if (direct) return direct
  for (const affected of vuln.affected ?? []) {
    const nested =
      normalizeSeverity(affected.database_specific?.severity) ??
      normalizeSeverity(affected.ecosystem_specific?.severity)
    if (nested) return nested
  }
  // Some records (e.g. Ubuntu) carry a qualitative rating in the severity list.
  for (const entry of vuln.severity ?? []) {
    const qualitative = normalizeSeverity(entry.score)
    if (qualitative) return qualitative
  }
  return "unknown"
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Render one OSV range's events as a compact constraint string, e.g. ">=0 <4.17.21". */
function formatRange(range: { events?: Record<string, string>[] }): string | undefined {
  const parts: string[] = []
  for (const event of range.events ?? []) {
    if (event.introduced !== undefined) parts.push(event.introduced === "0" ? ">=0" : `>=${event.introduced}`)
    if (event.fixed !== undefined) parts.push(`<${event.fixed}`)
    if (event.last_affected !== undefined) parts.push(`<=${event.last_affected}`)
    if (event.limit !== undefined) parts.push(`limit ${event.limit}`)
  }
  return parts.length ? parts.join(" ") : undefined
}

function mapAffected(entries: OsvAffected[] | undefined): NonNullable<VulnRecord["affected"]> {
  const result: NonNullable<VulnRecord["affected"]> = []
  for (const entry of entries ?? []) {
    const ranges: string[] = []
    let fixed: string | undefined
    for (const range of entry.ranges ?? []) {
      const formatted = formatRange(range)
      if (formatted) ranges.push(formatted)
      for (const event of range.events ?? []) {
        if (event.fixed !== undefined) fixed = event.fixed
      }
    }
    result.push({
      package: entry.package?.name ?? "unknown",
      ...(entry.package?.ecosystem ? { ecosystem: entry.package.ecosystem } : {}),
      ...(ranges.length ? { ranges: ranges.slice(0, 5) } : {}),
      ...(fixed ? { fixed } : {}),
    })
  }
  return result
}

function maliciousContext(vuln: OsvVuln) {
  const origins = (vuln.database_specific?.["malicious-packages-origins"] ?? []).slice(0, 10).map((origin) => ({
    ...(origin.source ? { source: clip(origin.source, 80) } : {}),
    ...(origin.id ? { id: clip(origin.id, 120) } : {}),
    ...(origin.versions ? { versions: origin.versions.slice(0, 20).map((version) => clip(version, 80)) } : {}),
    ...(origin.sha256 ? { sha256: clip(origin.sha256, 64) } : {}),
  }))
  const files: NonNullable<OsvRecord["evidenceFiles"]> = []
  for (const file of vuln.database_specific?.iocs?.files ?? []) {
    for (const path of file.paths ?? []) {
      if (files.length >= 20) break
      files.push({
        path: clip(path, 240),
        ...(file.sha256 ? { sha256: clip(file.sha256, 64) } : {}),
        ...(file.note ? { note: clip(file.note, 300) } : {}),
      })
    }
    if (files.length >= 20) break
  }
  for (const affected of vuln.affected ?? []) {
    for (const file of affected.database_specific?.indicators?.evidence_files ?? []) {
      if (files.length >= 20) break
      if (!file.path) continue
      files.push({
        path: clip(file.path, 240),
        ...(file.sha256 ? { sha256: clip(file.sha256, 64) } : {}),
        ...(file.tlsh ? { tlsh: clip(file.tlsh, 160) } : {}),
      })
    }
    if (files.length >= 20) break
  }
  const malicious = vuln.id.startsWith("MAL-") || origins.length > 0 || files.length > 0
  return {
    ...(malicious ? { classification: "malicious-package" as const } : {}),
    ...(origins.length ? { maliciousOrigins: origins } : {}),
    ...(files.length ? { evidenceFiles: files } : {}),
  }
}

/** Trim a raw OSV record to the agent-relevant VulnRecord shape. */
export function trimVuln(vuln: OsvVuln, maxReferences = 5): OsvRecord {
  const aliases = (vuln.aliases ?? []).slice(0, 10)
  const summary = clip(vuln.summary ?? vuln.details ?? "", 300)
  const affected = mapAffected(vuln.affected).slice(0, 10)
  const references = (vuln.references ?? [])
    .map((ref) => ref.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0)
    .slice(0, maxReferences)
  return {
    id: vuln.id,
    source: "osv",
    severity: osvSeverity(vuln),
    ...(aliases.length ? { aliases } : {}),
    ...(summary ? { summary } : {}),
    ...(affected.length ? { affected } : {}),
    ...(references.length ? { references } : {}),
    ...(vuln.modified ? { modified: vuln.modified } : {}),
    ...maliciousContext(vuln),
  }
}

function bySeverity(a: VulnRecord, b: VulnRecord): number {
  return SEVERITY_RANK[a.severity ?? "unknown"] - SEVERITY_RANK[b.severity ?? "unknown"]
}

function requireString(args: Record<string, unknown>, key: string, hint: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`"${key}" is required: ${hint}`)
  return value.trim()
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

interface PackageQuery {
  name: string
  ecosystem: string
  version?: string
}

function parseBatchEntries(raw: unknown): PackageQuery[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolError('"packages" must be a non-empty array of { name, ecosystem, version? } objects')
  }
  if (raw.length > MAX_BATCH_QUERIES) {
    throw new ToolError(`batch queries are limited to ${MAX_BATCH_QUERIES} packages per call; split the list`)
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ToolError(`packages[${index}] must be an object with "name" and "ecosystem"`)
    }
    const record = entry as Record<string, unknown>
    const name = requireString(record, "name", `packages[${index}] needs a package name`)
    const ecosystem = requireString(record, "ecosystem", `packages[${index}] needs an ecosystem (e.g. "npm", "PyPI")`)
    const version = optionalString(record, "version")
    return { name, ecosystem: OSV_ECOSYSTEMS[ecosystem.toLowerCase()] ?? ecosystem, ...(version ? { version } : {}) }
  })
}

function osvRequestError(error: unknown): never {
  if (error instanceof HttpError) {
    if (error.status === 400) {
      throw new ToolError(
        'OSV rejected the query (HTTP 400). Check the package name and ecosystem; common ecosystems are "npm", "PyPI", "Go", "crates.io", "Maven", "NuGet", "Packagist", "RubyGems".',
      )
    }
    throw new ToolError(`OSV API request failed (HTTP ${error.status}); try again shortly`)
  }
  throw error
}

async function queryBatch(entries: PackageQuery[], ctx: IntegrationContext): Promise<unknown> {
  const queries = entries.map((entry) => ({
    package: { name: entry.name, ecosystem: entry.ecosystem },
    ...(entry.version ? { version: entry.version } : {}),
  }))
  let response: OsvBatchResponse
  try {
    response = await fetchJson<OsvBatchResponse>(`${API}/querybatch`, {
      method: "POST",
      body: { queries },
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
    })
  } catch (error) {
    osvRequestError(error)
  }
  const results = entries.map((entry, index) => {
    const ids = (response.results?.[index]?.vulns ?? []).map((vuln) => vuln.id)
    return {
      package: entry.name,
      ecosystem: entry.ecosystem,
      ...(entry.version ? { version: entry.version } : {}),
      total: ids.length,
      vulnIds: ids.slice(0, MAX_IDS_PER_BATCH_RESULT),
      ...(response.results?.[index]?.next_page_token ? { more: true } : {}),
    }
  })
  return {
    total: results.length,
    results,
    note: "batch results carry vuln ids only; use osv_get_vuln for details",
  }
}

async function querySingle(query: PackageQuery, ctx: IntegrationContext): Promise<unknown> {
  let response: OsvQueryResponse
  try {
    response = await fetchJson<OsvQueryResponse>(`${API}/query`, {
      method: "POST",
      body: {
        package: { name: query.name, ecosystem: query.ecosystem },
        ...(query.version ? { version: query.version } : {}),
      },
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
    })
  } catch (error) {
    osvRequestError(error)
  }
  const records = (response.vulns ?? []).map((vuln) => trimVuln(vuln)).sort(bySeverity)
  return {
    package: query.name,
    ecosystem: query.ecosystem,
    ...(query.version ? { version: query.version } : {}),
    total: records.length,
    vulns: records.slice(0, MAX_RECORDS),
    ...(records.length > MAX_RECORDS ? { note: `showing top ${MAX_RECORDS} of ${records.length} by severity` } : {}),
    ...(response.next_page_token ? { more: true } : {}),
  }
}

export const Osv: Integration = {
  id: "osv",
  category: "data",
  description: "Query OSV vulnerabilities and OpenSSF malicious-package records",
  tools: [
    {
      name: "osv_query_package",
      description:
        "Look up known vulnerabilities and OpenSSF MAL malicious-package reports for a package in OSV.dev. " +
        "Provide name + ecosystem (+ version), or pass `packages` to check many packages in one batch call " +
        "(batch results return vuln ids only).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Package name, e.g. "lodash"' },
          ecosystem: {
            type: "string",
            description: 'Package ecosystem, e.g. "npm", "PyPI", "Go", "crates.io", "Maven", "RubyGems"',
          },
          version: {
            type: "string",
            description: "Exact version to check (optional; omit to list all known vulns for the package)",
          },
          packages: {
            type: "array",
            description: "Batch mode: query several packages at once instead of name/ecosystem/version",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                ecosystem: { type: "string" },
                version: { type: "string" },
              },
              required: ["name", "ecosystem"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (args.packages !== undefined) return queryBatch(parseBatchEntries(args.packages), ctx)
        const name = requireString(args, "name", 'the package name, e.g. "lodash" (or use "packages" for batch mode)')
        const rawEcosystem = requireString(args, "ecosystem", 'the package ecosystem, e.g. "npm", "PyPI", "Go"')
        const ecosystem = OSV_ECOSYSTEMS[rawEcosystem.toLowerCase()] ?? rawEcosystem
        const version = optionalString(args, "version")
        return querySingle({ name, ecosystem, ...(version ? { version } : {}) }, ctx)
      },
    },
    {
      name: "osv_get_vuln",
      description:
        "Fetch one OSV record by id (CVE-, GHSA-, OSV-, or MAL-), including bounded malicious-package origins " +
        "and evidence-file hashes when OpenSSF data is present.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: 'Vulnerability id, e.g. "GHSA-jfh8-c2jq-5wjy" or "CVE-2021-44228"' },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = requireString(args, "id", 'a vulnerability id such as "GHSA-..." or "CVE-..."')
        let vuln: OsvVuln
        try {
          vuln = await fetchJson<OsvVuln>(`${API}/vulns/${encodeURIComponent(id)}`, {
            cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
          })
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            throw new ToolError(
              `no OSV record found for "${id}"; use osv_query_package to search by package name + ecosystem`,
            )
          }
          osvRequestError(error)
        }
        const vectors = (vuln.severity ?? [])
          .map((entry) => entry.score)
          .filter((score): score is string => typeof score === "string" && score.length > 0)
          .slice(0, 3)
        return {
          ...trimVuln(vuln, 10),
          ...(vuln.details ? { details: clip(vuln.details, 1500) } : {}),
          ...(vuln.published ? { published: vuln.published } : {}),
          ...(vectors.length ? { cvssVectors: vectors } : {}),
        }
      },
    },
  ],
}
