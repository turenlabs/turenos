import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../registry"
import { ToolError, type IntegrationContext } from "../types"
import { HttpError, fetchJson } from "../util/http"

/**
 * CISA KEV — Known Exploited Vulnerabilities catalog.
 *
 * Cached-feed integration: downloads the full JSON catalog once from the
 * official CISA GitHub mirror (cisa.gov itself bot-blocks non-curl clients),
 * caches it 24h on disk (ctx.cacheDir), and answers lookups locally.
 * Data is CC0.
 */

const KEV_FEED_URL = ExtensionCatalog.dataEndpoint("security:kev")
const FEED_TTL_MS = 24 * 3_600_000
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/
const MAX_CVE_IDS = 100
const MAX_RECENT = 50
const DEFAULT_RECENT = 10
const MAX_ACTION_CHARS = 280

interface KevEntry {
  cveID?: string
  vendorProject?: string
  product?: string
  vulnerabilityName?: string
  dateAdded?: string
  shortDescription?: string
  requiredAction?: string
  dueDate?: string
  knownRansomwareCampaignUse?: string
}

interface KevCatalog {
  catalogVersion?: string
  dateReleased?: string
  count?: number
  vulnerabilities?: KevEntry[]
}

function trim(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function normalizeCveIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === "string")) {
    throw new ToolError('cve_ids must be a non-empty array of CVE id strings, e.g. ["CVE-2024-3094"]')
  }
  const ids = [...new Set(raw.map((id) => id.trim().toUpperCase()))]
  const invalid = ids.filter((id) => !CVE_PATTERN.test(id))
  if (invalid.length > 0) {
    throw new ToolError(`invalid CVE ids (expected CVE-YYYY-NNNN format): ${invalid.slice(0, 10).join(", ")}`)
  }
  if (ids.length > MAX_CVE_IDS) {
    throw new ToolError(`too many CVE ids (${ids.length}); pass at most ${MAX_CVE_IDS} per call`)
  }
  return ids
}

async function loadCatalog(ctx: IntegrationContext): Promise<KevCatalog & { vulnerabilities: KevEntry[] }> {
  let catalog: KevCatalog
  try {
    catalog = await fetchJson<KevCatalog>(KEV_FEED_URL, {
      cache: { dir: ctx.cacheDir, ttlMs: FEED_TTL_MS, key: "kev-catalog" },
    })
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the CISA KEV catalog${status}; check network access and retry later`)
  }
  if (!Array.isArray(catalog.vulnerabilities)) {
    throw new ToolError("CISA KEV catalog had an unexpected shape (no vulnerabilities array); retry later")
  }
  return { ...catalog, vulnerabilities: catalog.vulnerabilities }
}

function summarize(entry: KevEntry) {
  return {
    cve: entry.cveID,
    vendorProject: entry.vendorProject,
    product: entry.product,
    vulnerabilityName: entry.vulnerabilityName,
    dateAdded: entry.dateAdded,
    dueDate: entry.dueDate,
    knownRansomwareUse: entry.knownRansomwareCampaignUse === "Known",
  }
}

export const Kev: Integration = {
  id: "kev",
  category: "data",
  description: "Check CVEs against the CISA Known Exploited Vulnerabilities (KEV) catalog",
  tools: [
    {
      name: "kev_check",
      description:
        "Check whether CVE ids appear in the CISA Known Exploited Vulnerabilities catalog (actively exploited in the wild). Listed entries include the ransomware-campaign flag, dateAdded, and CISA's required action.",
      inputSchema: {
        type: "object",
        properties: {
          cve_ids: {
            type: "array",
            items: { type: "string" },
            description: 'CVE ids to check, e.g. ["CVE-2024-3094"] (max 100)',
          },
        },
        required: ["cve_ids"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ids = normalizeCveIds(args.cve_ids)
        const catalog = await loadCatalog(ctx)
        const byId = new Map<string, KevEntry>()
        for (const entry of catalog.vulnerabilities) {
          if (typeof entry.cveID === "string") byId.set(entry.cveID.toUpperCase(), entry)
        }
        const listed: unknown[] = []
        const notListed: string[] = []
        for (const id of ids) {
          const entry = byId.get(id)
          if (!entry) {
            notListed.push(id)
            continue
          }
          listed.push({ ...summarize(entry), requiredAction: trim(entry.requiredAction, MAX_ACTION_CHARS) })
        }
        return {
          source: "kev",
          catalogVersion: catalog.catalogVersion,
          dateReleased: catalog.dateReleased,
          catalogSize: catalog.vulnerabilities.length,
          checked: ids.length,
          listed,
          notListed,
        }
      },
    },
    {
      name: "kev_recent",
      description: "List the most recent additions to the CISA Known Exploited Vulnerabilities catalog.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: `How many recent additions to return (default ${DEFAULT_RECENT}, max ${MAX_RECENT})`,
          },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const raw = args.limit ?? DEFAULT_RECENT
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_RECENT) {
          throw new ToolError(`limit must be an integer between 1 and ${MAX_RECENT}`)
        }
        const catalog = await loadCatalog(ctx)
        const entries = [...catalog.vulnerabilities]
          .sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""))
          .slice(0, raw)
          .map(summarize)
        return {
          source: "kev",
          catalogVersion: catalog.catalogVersion,
          dateReleased: catalog.dateReleased,
          catalogSize: catalog.vulnerabilities.length,
          entries,
        }
      },
    },
  ],
}
