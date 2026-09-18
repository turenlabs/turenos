import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const API = ExtensionCatalog.dataEndpoint("security:euvd")
const CACHE_TTL_MS = 3_600_000
const DEFAULT_RECENT = 10
const MAX_RESULTS = 20
const ATTRIBUTION = "European Union Vulnerability Database (EUVD), ENISA"
const ENISA_ID = /^EUVD-\d{4}-\d+$/
const CVE_ID = /^CVE-\d{4}-\d{4,}$/
const GHSA_ID = /^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

type JsonObject = Record<string, unknown>

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requiredId(args: Record<string, unknown>) {
  validateKeys(args, ["id"])
  if (typeof args.id !== "string" || args.id.trim() === "") {
    throw new ToolError('"id" must be an ENISA (EUVD-...), CVE, or GHSA identifier')
  }
  const id = args.id.trim().toUpperCase()
  if (!ENISA_ID.test(id) && !CVE_ID.test(id) && !GHSA_ID.test(id)) {
    throw new ToolError(
      `invalid vulnerability id "${args.id}"; use an EUVD-YYYY-N, CVE-YYYY-NNNN, or GHSA-xxxx-xxxx-xxxx id`,
    )
  }
  return id
}

function clip(value: string, max: number) {
  const compact = value.replaceAll(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function text(record: JsonObject, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "string")
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function numeric(record: JsonObject, ...keys: string[]): number | undefined {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "number")
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function strings(value: unknown, max: number): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,;]\s*/) : []
  return values
    .flatMap((entry) => {
      if (typeof entry === "string" && entry.trim() !== "") return [clip(entry.trim(), 180)]
      const item = object(entry)
      const candidate = item ? text(item, "url", "id", "name", "value") : undefined
      return candidate ? [clip(candidate, 180)] : []
    })
    .slice(0, max)
}

function records(value: unknown): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = object(entry)
      return record ? [record] : []
    })
  }
  const root = object(value)
  if (!root) return []
  for (const key of ["data", "results", "items", "vulnerabilities", "vulnerability"]) {
    const nested = root[key]
    if (Array.isArray(nested)) {
      return nested.flatMap((entry) => {
        const record = object(entry)
        return record ? [record] : []
      })
    }
    const nestedObject = object(nested)
    if (nestedObject) return [nestedObject]
  }
  return [root]
}

function summarize(record: JsonObject) {
  const id = text(record, "enisaId", "enisa_id", "id")
  const aliases = [
    ...strings(record.aliases, 8),
    ...strings(record.identifiers, 8),
    ...strings(record.cveId ?? record.cve, 2),
    ...strings(record.ghsaId ?? record.ghsa, 2),
  ]
    .filter((value, index, all) => value !== id && all.indexOf(value) === index)
    .slice(0, 8)
    .map((value) => clip(value, 64))
  const summary = text(record, "description", "summary", "title")
  const score = numeric(record, "baseScore", "cvssScore", "score")
  const scoreVersion = text(record, "baseScoreVersion", "cvssVersion")
  const severity = text(record, "severity", "baseSeverity")
  const published = text(record, "datePublished", "published", "publishedAt")
  const updated = text(record, "dateUpdated", "updated", "lastModified")
  const references = strings(record.references ?? record.referenceUrls ?? record.urls, 4)
  const products = strings(record.affectedProducts ?? record.products ?? record.product, 5).map((value) =>
    clip(value, 120),
  )
  return {
    ...(id ? { id } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(summary ? { summary: clip(summary, 300) } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(scoreVersion ? { scoreVersion } : {}),
    ...(severity ? { severity } : {}),
    ...(published ? { published } : {}),
    ...(updated ? { updated } : {}),
    ...(products.length ? { affectedProducts: products } : {}),
    ...(references.length ? { references } : {}),
  }
}

async function request(ctx: IntegrationContext, path: string): Promise<unknown> {
  try {
    return await fetchJson(`${API}/${path}`, {
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
      fixedEndpoint: { id: "euvd", endpoint: API, pathPrefix: "/api/" },
      maxResponseBytes: 2 * 1024 * 1024,
    })
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new ToolError("EUVD did not find that vulnerability; check the identifier and try again")
    }
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`EUVD request failed${status}; check network access and retry later`)
  }
}

export const Euvd: Integration = {
  id: "euvd",
  category: "data",
  description: "Look up vulnerability records in ENISA's European Union Vulnerability Database",
  tools: [
    {
      name: "euvd_lookup",
      description: "Look up an EUVD record by ENISA EUVD id, CVE id, or GHSA id. Source: ENISA EUVD.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "EUVD-YYYY-N, CVE-YYYY-NNNN, or GHSA-xxxx-xxxx-xxxx" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const id = requiredId(args)
        const endpoint = ENISA_ID.test(id) ? "enisaid" : "search"
        const parameter = ENISA_ID.test(id) ? "id" : "text"
        const response = await request(ctx, `${endpoint}?${parameter}=${encodeURIComponent(id)}`)
        const matches = records(response).slice(0, MAX_RESULTS).map(summarize)
        if (matches.length === 0) throw new ToolError(`EUVD has no record for "${id}"; check the identifier`)
        return { source: ATTRIBUTION, query: id, total: matches.length, vulnerabilities: matches }
      },
    },
    {
      name: "euvd_recent",
      description: "List recent vulnerability records published by ENISA EUVD (maximum 20).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: `Number of records (default ${DEFAULT_RECENT}, max ${MAX_RESULTS})` },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["limit"])
        const limit = args.limit ?? DEFAULT_RECENT
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
          throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
        }
        const entries = records(await request(ctx, "lastvulnerabilities"))
          .slice(0, limit)
          .map(summarize)
        return { source: ATTRIBUTION, total: entries.length, vulnerabilities: entries }
      },
    },
  ],
}
