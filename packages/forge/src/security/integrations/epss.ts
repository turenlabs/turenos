import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../registry"
import { ToolError } from "../types"
import { HttpError, fetchJson } from "../util/http"

/**
 * FIRST EPSS — Exploit Prediction Scoring System.
 * API: https://api.first.org/data/v1/epss?cve=CVE-...,CVE-... (no key, JSON).
 *
 * Per-query API: CVE ids are batched into as few requests as possible and
 * responses are cached ~1h on disk (ctx.cacheDir). Attribution requested by
 * FIRST.org is included as `source`.
 */

const EPSS_API_URL = ExtensionCatalog.dataEndpoint("security:epss")
const ATTRIBUTION = "EPSS by FIRST.org"
const QUERY_TTL_MS = 3_600_000
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/
const MAX_CVE_IDS = 200
const CHUNK_SIZE = 100

interface EpssRow {
  cve?: string
  epss?: string
  percentile?: string
  date?: string
}

interface EpssResponse {
  status?: string
  total?: number
  data?: EpssRow[]
}

function normalizeCveIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === "string")) {
    throw new ToolError('cve_ids must be a non-empty array of CVE id strings, e.g. ["CVE-2024-3094"]')
  }
  // Sort + dedupe so identical queries hit the same cache entry regardless of order.
  const ids = [...new Set(raw.map((id) => id.trim().toUpperCase()))].sort()
  const invalid = ids.filter((id) => !CVE_PATTERN.test(id))
  if (invalid.length > 0) {
    throw new ToolError(`invalid CVE ids (expected CVE-YYYY-NNNN format): ${invalid.slice(0, 10).join(", ")}`)
  }
  if (ids.length > MAX_CVE_IDS) {
    throw new ToolError(`too many CVE ids (${ids.length}); pass at most ${MAX_CVE_IDS} per call`)
  }
  return ids
}

function toScore(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export const Epss: Integration = {
  id: "epss",
  category: "data",
  description: "Fetch EPSS exploit-probability scores for CVEs from FIRST.org",
  tools: [
    {
      name: "epss_score",
      description:
        "Get EPSS scores (probability of exploitation in the next 30 days, 0..1, plus percentile) for one or more CVE ids.",
      inputSchema: {
        type: "object",
        properties: {
          cve_ids: {
            type: "array",
            items: { type: "string" },
            description: 'CVE ids to score, e.g. ["CVE-2024-3094"] (max 200)',
          },
        },
        required: ["cve_ids"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ids = normalizeCveIds(args.cve_ids)
        const rows: EpssRow[] = []
        for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
          const chunk = ids.slice(offset, offset + CHUNK_SIZE)
          const url = `${EPSS_API_URL}?cve=${chunk.join(",")}&limit=${CHUNK_SIZE}`
          let response: EpssResponse
          try {
            response = await fetchJson<EpssResponse>(url, {
              cache: { dir: ctx.cacheDir, ttlMs: QUERY_TTL_MS },
            })
          } catch (error) {
            const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
            throw new ToolError(`EPSS API request failed${status}; check network access and retry later`)
          }
          if (Array.isArray(response.data)) rows.push(...response.data)
        }

        const scored = new Map<string, { cve: string; epss?: number; percentile?: number; date?: string }>()
        for (const row of rows) {
          if (typeof row.cve !== "string") continue
          scored.set(row.cve.toUpperCase(), {
            cve: row.cve.toUpperCase(),
            epss: toScore(row.epss),
            percentile: toScore(row.percentile),
            date: row.date,
          })
        }

        const scores = ids.flatMap((id) => {
          const hit = scored.get(id)
          return hit ? [{ cve: hit.cve, epss: hit.epss, percentile: hit.percentile }] : []
        })
        const notFound = ids.filter((id) => !scored.has(id))
        const date = rows.find((row) => typeof row.date === "string")?.date
        return {
          source: ATTRIBUTION,
          date,
          scores,
          notFound,
        }
      },
    },
  ],
}
