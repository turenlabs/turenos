import type { Integration } from "../registry"
import { ToolError, type IntegrationContext } from "../types"
import { fetchJson, HttpError } from "../util/http"

/**
 * NVD — NIST National Vulnerability Database.
 * API: GET https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-...
 *
 * Rate limits: keyless 5 req / 30s; with an API key (ctx.secrets.NVD_KEY, env
 * FORGE_SECURITY_NVD_KEY, sent as the "apiKey" header) 50 req / 30s. A
 * client-side sliding-window throttle enforces whichever tier applies before
 * any network request; per-query responses are cached ~1h in ctx.cacheDir.
 *
 * NVD ToS requires the notice below on every result.
 */

const API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
const CACHE_TTL_MS = 3_600_000 // ~1h, per CONVENTIONS.md for per-query APIs
const NOTICE = "This product uses the NVD API but is not endorsed or certified by the NVD."

const WINDOW_MS = 30_000
const KEYLESS_LIMIT = 5
const KEYED_LIMIT = 50

/**
 * Timestamps of recent request slots (sliding window). Cache hits also consume
 * a slot — the cache lives inside util/http so a miss cannot be detected here
 * ahead of time — which only over-throttles, never under-throttles.
 */
const requestSlots: number[] = []

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Wait until a request slot is free within the 30s window, then claim it. */
async function throttle(limit: number): Promise<void> {
  for (;;) {
    const now = Date.now()
    while (requestSlots.length > 0 && now - requestSlots[0] >= WINDOW_MS) requestSlots.shift()
    if (requestSlots.length < limit) {
      requestSlots.push(now)
      return
    }
    await sleep(WINDOW_MS - (now - requestSlots[0]) + 50)
  }
}

interface NvdCve {
  id: string
  published?: string
  lastModified?: string
  vulnStatus?: string
  descriptions?: { lang?: string; value?: string }[]
  metrics?: Record<
    string,
    {
      type?: string
      baseSeverity?: string
      cvssData?: { version?: string; vectorString?: string; baseScore?: number; baseSeverity?: string }
    }[]
  >
  weaknesses?: { description?: { lang?: string; value?: string }[] }[]
  configurations?: {
    nodes?: {
      cpeMatch?: {
        vulnerable?: boolean
        criteria?: string
        versionStartIncluding?: string
        versionStartExcluding?: string
        versionEndIncluding?: string
        versionEndExcluding?: string
      }[]
    }[]
  }[]
  references?: { url?: string; tags?: string[] }[]
}

interface NvdResponse {
  totalResults?: number
  vulnerabilities?: { cve?: NvdCve }[]
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** One entry per CVSS version present, primary source preferred. */
function mapCvss(
  metrics: NvdCve["metrics"],
): { version: string; vector?: string; score?: number; severity?: string }[] {
  const result: { version: string; vector?: string; score?: number; severity?: string }[] = []
  const order: [string, string][] = [
    ["cvssMetricV40", "4.0"],
    ["cvssMetricV31", "3.1"],
    ["cvssMetricV30", "3.0"],
    ["cvssMetricV2", "2.0"],
  ]
  for (const [key, version] of order) {
    const list = metrics?.[key]
    if (!list?.length) continue
    const metric = list.find((entry) => entry.type === "Primary") ?? list[0]
    const severity = metric.cvssData?.baseSeverity ?? metric.baseSeverity
    result.push({
      version,
      ...(metric.cvssData?.vectorString ? { vector: metric.cvssData.vectorString } : {}),
      ...(typeof metric.cvssData?.baseScore === "number" ? { score: metric.cvssData.baseScore } : {}),
      ...(severity ? { severity: severity.toLowerCase() } : {}),
    })
  }
  return result
}

function mapCwes(weaknesses: NvdCve["weaknesses"]): string[] {
  const cwes = new Set<string>()
  for (const weakness of weaknesses ?? []) {
    for (const description of weakness.description ?? []) {
      if (description.lang === "en" && description.value && description.value.startsWith("CWE-")) {
        cwes.add(description.value)
      }
    }
  }
  return [...cwes].slice(0, 10)
}

/** Compact strings for the vulnerable CPE configurations, e.g. "cpe:2.3:... (<5.6.1)". */
function mapCpe(configurations: NvdCve["configurations"]): { total: number; entries: string[] } {
  const entries: string[] = []
  let total = 0
  for (const configuration of configurations ?? []) {
    for (const node of configuration.nodes ?? []) {
      for (const match of node.cpeMatch ?? []) {
        if (match.vulnerable === false || !match.criteria) continue
        total++
        if (entries.length >= 10) continue
        const bounds: string[] = []
        if (match.versionStartIncluding) bounds.push(`>=${match.versionStartIncluding}`)
        if (match.versionStartExcluding) bounds.push(`>${match.versionStartExcluding}`)
        if (match.versionEndIncluding) bounds.push(`<=${match.versionEndIncluding}`)
        if (match.versionEndExcluding) bounds.push(`<${match.versionEndExcluding}`)
        entries.push(bounds.length ? `${match.criteria} (${bounds.join(" ")})` : match.criteria)
      }
    }
  }
  return { total, entries }
}

export const Nvd: Integration = {
  id: "nvd",
  category: "data",
  description: "Query the NIST National Vulnerability Database (NVD) for CVE details",
  secrets: ["NVD_KEY"],
  tools: [
    {
      name: "nvd_cve_detail",
      description:
        "Fetch CVE details from the NVD: description, CVSS vectors and scores, CWEs, vulnerable CPE summary, " +
        "and top references.",
      inputSchema: {
        type: "object",
        properties: {
          cveId: { type: "string", description: 'CVE id, e.g. "CVE-2024-3094"' },
        },
        required: ["cveId"],
        additionalProperties: false,
      },
      handler: async (args, ctx: IntegrationContext) => {
        const raw = args.cveId
        if (typeof raw !== "string" || raw.trim() === "") {
          throw new ToolError('"cveId" is required, e.g. "CVE-2024-3094"')
        }
        const cveId = raw.trim().toUpperCase()
        if (!/^CVE-\d{4}-\d{4,}$/.test(cveId)) {
          throw new ToolError(`"${raw}" is not a valid CVE id; expected the form "CVE-2024-3094"`)
        }

        const key = ctx.secrets.NVD_KEY
        await throttle(key ? KEYED_LIMIT : KEYLESS_LIMIT)

        let response: NvdResponse
        try {
          response = await fetchJson<NvdResponse>(`${API}?cveId=${encodeURIComponent(cveId)}`, {
            ...(key ? { headers: { apiKey: key } } : {}),
            cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
          })
        } catch (error) {
          if (error instanceof HttpError) {
            if (error.status === 403) {
              throw new ToolError(
                key
                  ? "NVD rejected the request (HTTP 403): rate limit hit or invalid API key. Check FORGE_SECURITY_NVD_KEY and retry in ~30s."
                  : "NVD rate limit hit (HTTP 403; keyless access is 5 req/30s). Retry in ~30s, or set FORGE_SECURITY_NVD_KEY for 50 req/30s.",
              )
            }
            if (error.status === 404) {
              throw new ToolError(`NVD rejected the request for "${cveId}" (HTTP 404); check the CVE id`)
            }
            throw new ToolError(`NVD API request failed (HTTP ${error.status}); try again shortly`)
          }
          throw error
        }

        const cve = response.vulnerabilities?.[0]?.cve
        if (!cve) {
          throw new ToolError(`"${cveId}" was not found in the NVD; check the id or try osv_get_vuln / ghsa_lookup`)
        }

        const description = cve.descriptions?.find((entry) => entry.lang === "en")?.value
        const cvss = mapCvss(cve.metrics)
        const cwes = mapCwes(cve.weaknesses)
        const cpe = mapCpe(cve.configurations)
        const references = (cve.references ?? []).slice(0, 8).map((reference) => ({
          url: reference.url ?? "",
          ...(reference.tags?.length ? { tags: reference.tags.slice(0, 4) } : {}),
        }))

        return {
          notice: NOTICE, // required by the NVD API terms of service
          id: cve.id,
          ...(cve.vulnStatus ? { status: cve.vulnStatus } : {}),
          ...(cve.published ? { published: cve.published } : {}),
          ...(cve.lastModified ? { lastModified: cve.lastModified } : {}),
          ...(description ? { description: clip(description, 1000) } : {}),
          ...(cvss.length ? { cvss } : {}),
          ...(cwes.length ? { cwes } : {}),
          ...(cpe.total > 0 ? { vulnerableCpe: cpe } : {}),
          ...(references.length ? { references } : {}),
        }
      },
    },
  ],
}
