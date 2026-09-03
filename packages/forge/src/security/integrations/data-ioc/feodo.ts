import { isIP } from "node:net"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const ENDPOINT = "https://feodotracker.abuse.ch"
const FEED_URL = `${ENDPOINT}/downloads/ipblocklist_recommended.json`
const SOURCE = "Feodo Tracker by abuse.ch (CC0, feodotracker.abuse.ch)"
const CACHE_TTL_MS = 5 * 60_000
const MAX_RECENT = 50
const DEFAULT_RECENT = 10
const MAX_TEXT_CHARS = 160

interface FeodoEntry {
  ip: string
  port?: number
  status?: string
  hostname?: string
  asNumber?: number
  asName?: string
  country?: string
  firstSeen?: string
  lastOnline?: string
  malware?: string
}

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (text === "") return undefined
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseEntry(value: unknown): FeodoEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const ip = bounded(record.ip_address ?? record.dst_ip ?? record.ip)
  if (!ip || isIP(ip) === 0) return undefined
  const port = number(record.port ?? record.dst_port)
  const asNumber = number(record.as_number ?? record.asn)
  return {
    ip: ip.toLowerCase(),
    port: Number.isInteger(port) && port! >= 1 && port! <= 65_535 ? port : undefined,
    status: bounded(record.status ?? record.c2_status),
    hostname: bounded(record.hostname),
    asNumber: Number.isInteger(asNumber) && asNumber! >= 0 ? asNumber : undefined,
    asName: bounded(record.as_name),
    country: bounded(record.country),
    firstSeen: bounded(record.first_seen),
    lastOnline: bounded(record.last_online),
    malware: bounded(record.malware),
  }
}

async function loadFeed(ctx: IntegrationContext): Promise<FeodoEntry[]> {
  const request = {
    cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "feodo-recommended" },
    maxResponseBytes: 16_000_000,
    fixedEndpoint: { id: "feodo", endpoint: ENDPOINT, pathPrefix: "/downloads" },
  }
  let response: unknown
  try {
    response = await fetchJson(FEED_URL, request)
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the Feodo Tracker blocklist${status}; check network access and retry later`)
  }
  if (!Array.isArray(response)) {
    throw new ToolError("Feodo Tracker returned an unexpected response; retry later")
  }
  const entries = response.map(parseEntry).filter((entry): entry is FeodoEntry => entry !== undefined)
  if (response.length > 0 && entries.length === 0) {
    throw new ToolError("Feodo Tracker blocklist entries had an unexpected shape; retry later")
  }
  return entries
}

function requireIp(value: unknown): string {
  if (typeof value !== "string" || isIP(value.trim()) === 0) {
    throw new ToolError('"ip" must be a valid IPv4 or IPv6 address')
  }
  return value.trim().toLowerCase()
}

export const Feodo: Integration = {
  id: "feodo",
  category: "data",
  description: "Check botnet C2 IPs and recent entries from the Feodo Tracker blocklist",
  tools: [
    {
      name: "feodo_ip_lookup",
      description:
        "Check an IP against the cached Feodo Tracker recommended botnet C2 blocklist. The listed destination is never contacted.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string", description: "IPv4 or IPv6 address to check" } },
        required: ["ip"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ip = requireIp(args.ip)
        const matches = (await loadFeed(ctx)).filter((entry) => entry.ip === ip).slice(0, MAX_RECENT)
        return { source: SOURCE, ip, listed: matches.length > 0, matches }
      },
    },
    {
      name: "feodo_recent",
      description: "List the most recently first-seen entries in the cached Feodo Tracker recommended blocklist.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: `Number of entries to return (default ${DEFAULT_RECENT}, max ${MAX_RECENT})`,
          },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const limit = args.limit ?? DEFAULT_RECENT
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT) {
          throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RECENT}`)
        }
        const entries = await loadFeed(ctx)
        return {
          source: SOURCE,
          total: entries.length,
          entries: [...entries]
            .sort((left, right) => (right.firstSeen ?? "").localeCompare(left.firstSeen ?? ""))
            .slice(0, limit),
        }
      },
    },
  ],
}
