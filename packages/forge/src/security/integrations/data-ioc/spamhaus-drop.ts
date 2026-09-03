import { isIP } from "node:net"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchText, HttpError } from "../../util/http"

const ENDPOINT = "https://www.spamhaus.org"
const IPV4_FEED = `${ENDPOINT}/drop/drop_v4.json`
const IPV6_FEED = `${ENDPOINT}/drop/drop_v6.json`
const ASN_FEED = `${ENDPOINT}/drop/asndrop.json`
const SOURCE = "Spamhaus DROP (spamhaus.org/drop, fair-use attribution required)"
const CACHE_TTL_MS = 24 * 3_600_000

interface DropNetwork {
  cidr: string
  sblid?: string
  rir?: string
}

interface DropAsn {
  asn: number
  rir?: string
  domain?: string
  country?: string
  name?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown, max = 160) {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const normalized = value.trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function jsonLines(value: string) {
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      // Spamhaus publishes one bounded JSON object per line, not one JSON document.
      const parsed = record(JSON.parse(line))
      return parsed ? [parsed] : []
    } catch {
      return []
    }
  })
}

export function parseDropNetworks(value: string): DropNetwork[] {
  const entries = jsonLines(value).flatMap((item) => {
    const cidr = text(item.cidr, 64)
    if (!cidr || !cidr.includes("/")) return []
    return [{ cidr, sblid: text(item.sblid, 32), rir: text(item.rir, 24) }]
  })
  if (entries.length === 0) throw new ToolError("Spamhaus DROP network feed had no valid entries; retry later")
  return entries
}

export function parseDropAsns(value: string): DropAsn[] {
  const entries = jsonLines(value).flatMap((item) => {
    const asn = typeof item.asn === "number" ? item.asn : Number(item.asn)
    if (!Number.isSafeInteger(asn) || asn < 1 || asn > 4_294_967_295) return []
    return [
      {
        asn,
        rir: text(item.rir, 24),
        domain: text(item.domain),
        country: text(item.cc, 2),
        name: text(item.asname),
      },
    ]
  })
  if (entries.length === 0) throw new ToolError("Spamhaus ASN-DROP feed had no valid entries; retry later")
  return entries
}

async function loadFeed(url: string, key: string, ctx: IntegrationContext) {
  try {
    return await fetchText(url, {
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key },
      fixedEndpoint: { id: "spamhaus-drop", endpoint: ENDPOINT, pathPrefix: "/drop" },
      maxResponseBytes: 16 * 1024 * 1024,
    })
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download Spamhaus DROP data${status}; check network access and retry later`)
  }
}

function ipValue(value: string) {
  if (isIP(value) === 4) {
    return value.split(".").reduce((result, part) => (result << 8n) | BigInt(part), 0n)
  }
  const sides = value.toLowerCase().split("::")
  if (sides.length > 2) return undefined
  const parse = (side: string) => (side ? side.split(":").map((part) => Number.parseInt(part, 16)) : [])
  const left = parse(sides[0] ?? "")
  const right = parse(sides[1] ?? "")
  const groups = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left
  if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return undefined
  }
  return groups.reduce((result, part) => (result << 16n) | BigInt(part), 0n)
}

function contains(cidr: string, ip: string) {
  const [base, rawPrefix] = cidr.split("/")
  const family = isIP(ip)
  if (!base || isIP(base) !== family) return false
  const bits = family === 4 ? 32 : 128
  const prefix = Number(rawPrefix)
  const address = ipValue(ip)
  const network = ipValue(base)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits || address === undefined || network === undefined) {
    return false
  }
  const shift = BigInt(bits - prefix)
  return address >> shift === network >> shift
}

function requireIp(value: unknown) {
  if (typeof value !== "string" || isIP(value.trim()) === 0) {
    throw new ToolError('"ip" must be a valid IPv4 or IPv6 address')
  }
  return value.trim().toLowerCase()
}

function requireAsn(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().replace(/^AS/i, "") : value
  const asn = typeof normalized === "number" ? normalized : Number(normalized)
  if (!Number.isSafeInteger(asn) || asn < 1 || asn > 4_294_967_295) {
    throw new ToolError('"asn" must be an integer or AS-prefixed value between 1 and 4294967295')
  }
  return asn
}

export const SpamhausDrop: Integration = {
  id: "spamhaus-drop",
  category: "data",
  description: "Check IP addresses and autonomous systems against Spamhaus DROP",
  tools: [
    {
      name: "spamhaus_drop_ip",
      description: "Check an IPv4 or IPv6 address against the cached Spamhaus DROP network lists.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string", description: "IPv4 or IPv6 address to check" } },
        required: ["ip"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const ip = requireIp(args.ip)
        const feed = isIP(ip) === 4 ? IPV4_FEED : IPV6_FEED
        const matches = parseDropNetworks(await loadFeed(feed, isIP(ip) === 4 ? "drop-ipv4" : "drop-ipv6", ctx))
          .filter((entry) => contains(entry.cidr, ip))
          .slice(0, 10)
        return { source: SOURCE, ip, listed: matches.length > 0, matches }
      },
    },
    {
      name: "spamhaus_drop_asn",
      description: "Check an autonomous system number against the cached Spamhaus ASN-DROP list.",
      inputSchema: {
        type: "object",
        properties: { asn: { description: "ASN as an integer or AS-prefixed string" } },
        required: ["asn"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const asn = requireAsn(args.asn)
        const matches = parseDropAsns(await loadFeed(ASN_FEED, "drop-asn", ctx)).filter((entry) => entry.asn === asn)
        return { source: SOURCE, asn: `AS${asn}`, listed: matches.length > 0, matches }
      },
    },
  ],
}
