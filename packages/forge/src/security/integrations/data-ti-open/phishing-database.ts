import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchText, HttpError } from "../../util/http"

const ENDPOINT = "https://raw.githubusercontent.com"
const PATH = "/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt"
const CACHE_TTL_MS = 6 * 3_600_000
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
let parsedFeed: { expiresAt: number; domains: Set<string> } | undefined
let loading: Promise<Set<string>> | undefined

function hostname(value: unknown) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2_048) {
    throw new ToolError('"target" must be a hostname or URL of at most 2048 characters')
  }
  const input = value.trim()
  const host = (() => {
    try {
      return new URL(input.includes("://") ? input : `https://${input}`).hostname
    } catch {
      return ""
    }
  })()
    .toLowerCase()
    .replace(/\.$/, "")
  if (!DOMAIN.test(host)) throw new ToolError('"target" must contain a valid DNS hostname')
  return host
}

export function parsePhishingDomains(value: string) {
  const lines = value
    .split("\n")
    .map((line) => line.trim().toLowerCase().replace(/\.$/, ""))
    .filter((line) => line !== "" && !line.startsWith("#"))
  const valid = lines.filter((line) => DOMAIN.test(line))
  const unique = new Set(valid)
  if (unique.size < 1_000 || valid.length / Math.max(lines.length, 1) < 0.99) {
    throw new ToolError("Phishing.Database feed had an unexpected or incomplete shape; refusing false-negative results")
  }
  return unique
}

async function domains(ctx: IntegrationContext) {
  if (parsedFeed && parsedFeed.expiresAt > Date.now()) return parsedFeed.domains
  if (loading) return loading
  loading = loadDomains(ctx)
  try {
    return await loading
  } finally {
    loading = undefined
  }
}

async function loadDomains(ctx: IntegrationContext) {
  try {
    const value = parsePhishingDomains(
      await fetchText(`${ENDPOINT}${PATH}`, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "active-domains" },
        fixedEndpoint: { id: "phishing-database", endpoint: ENDPOINT, pathPrefix: PATH },
        maxResponseBytes: 16 * 1024 * 1024,
      }),
    )
    parsedFeed = { expiresAt: Date.now() + CACHE_TTL_MS, domains: value }
    return value
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`Phishing.Database feed download failed${status}; retry later`)
  }
}

export const PhishingDatabase: Integration = {
  id: "phishing-database",
  category: "data",
  description: "Check domains against Phishing.Database's actively retested phishing feed",
  tools: [
    {
      name: "phishing_database_lookup",
      description:
        "Check a hostname or URL hostname against the active Phishing.Database domain feed. The input URL is parsed locally and never contacted.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string", description: "Hostname or URL to classify without dereferencing" } },
        required: ["target"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const target = hostname(args.target)
        return {
          source: "Phishing.Database",
          license: "MIT",
          target,
          activePhishing: (await domains(ctx)).has(target),
          caution:
            "A match is community-maintained phishing context; not-found is unknown. Prefer exact host evidence and preserve the source attribution.",
        }
      },
    },
  ],
}
