import { isIP } from "node:net"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchText, HttpError } from "../../util/http"

const ENDPOINT = "https://sslbl.abuse.ch"
const CERTIFICATE_FEED = `${ENDPOINT}/blacklist/sslblacklist.csv`
const IP_FEED = `${ENDPOINT}/blacklist/sslipblacklist.csv`
const SOURCE = "SSLBL by abuse.ch (CC0, sslbl.abuse.ch)"
const CACHE_TTL_MS = 5 * 60_000
const SHA1_RE = /^[0-9a-f]{40}$/i
const MAX_MATCHES = 50
const MAX_TEXT_CHARS = 200

interface CertificateEntry {
  sha1: string
  listingDate?: string
  reason?: string
}

interface IpEntry {
  ip: string
  port?: number
  listingDate?: string
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === "") return undefined
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text
}

/** Parse RFC 4180-style CSV, including quoted commas/newlines and escaped quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  const pushRow = () => {
    row.push(field)
    if (row.some((cell) => cell.trim() !== "")) rows.push(row)
    row = []
    field = ""
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index++
        continue
      }
      if (character === '"') {
        inQuotes = false
        continue
      }
      field += character
      continue
    }
    if (character === '"') {
      inQuotes = true
      continue
    }
    if (character === ",") {
      row.push(field)
      field = ""
      continue
    }
    if (character === "\n") {
      pushRow()
      continue
    }
    if (character !== "\r") field += character
  }
  if (field !== "" || row.length > 0) pushRow()
  return rows.filter(
    (cells) =>
      !cells[0]
        ?.replace(/^\uFEFF/, "")
        .trimStart()
        .startsWith("#"),
  )
}

function headerPosition(header: string[], names: string[]): number | undefined {
  const index = header
    .map((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""),
    )
    .findIndex((name) => names.includes(name))
  return index < 0 ? undefined : index
}

export function parseSslblCertificates(text: string): CertificateEntry[] {
  const rows = parseCsv(text)
  const header = rows[0] ?? []
  const hashIndex = headerPosition(header, ["sha1", "sha1fingerprint", "fingerprint"])
  const dateIndex = headerPosition(header, ["listingdate", "firstseen", "date"])
  const reasonIndex = headerPosition(header, ["listingreason", "reason", "malware"])
  const entries = (hashIndex === undefined ? rows : rows.slice(1)).flatMap((row) => {
    const fallbackHash = row.findIndex((cell) => SHA1_RE.test(cell.trim()))
    const at = hashIndex ?? fallbackHash
    if (at < 0) return []
    const sha1 = row[at]?.trim().toUpperCase()
    if (!sha1 || !SHA1_RE.test(sha1)) return []
    return [
      {
        sha1,
        listingDate: dateIndex === undefined ? (at > 0 ? bounded(row[at - 1]) : undefined) : bounded(row[dateIndex]),
        reason: bounded(row[reasonIndex ?? at + 1]),
      },
    ]
  })
  if (entries.length === 0) throw new ToolError("SSLBL certificate feed had no valid entries; retry later")
  return entries
}

export function parseSslblIps(text: string): IpEntry[] {
  const rows = parseCsv(text)
  const header = rows[0] ?? []
  const ipIndex = headerPosition(header, ["dstip", "ip", "ipaddress", "destinationip"])
  const portIndex = headerPosition(header, ["dstport", "port", "destinationport"])
  const dateIndex = headerPosition(header, ["listingdate", "firstseen", "date"])
  const entries = (ipIndex === undefined ? rows : rows.slice(1)).flatMap((row) => {
    const fallbackIp = row.findIndex((cell) => isIP(cell.trim()) !== 0)
    const at = ipIndex ?? fallbackIp
    if (at < 0) return []
    const ip = row[at]?.trim().toLowerCase()
    if (!ip || isIP(ip) === 0) return []
    const rawPort = row[portIndex ?? at + 1]?.trim()
    const port = rawPort === undefined || rawPort === "" ? undefined : Number(rawPort)
    return [
      {
        ip,
        port: Number.isInteger(port) && port! >= 1 && port! <= 65_535 ? port : undefined,
        listingDate: dateIndex === undefined ? (at > 0 ? bounded(row[at - 1]) : undefined) : bounded(row[dateIndex]),
      },
    ]
  })
  if (entries.length === 0) throw new ToolError("SSLBL IP feed had no valid entries; retry later")
  return entries
}

async function loadFeed(url: string, key: string, ctx: IntegrationContext): Promise<string> {
  const request = {
    cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key },
    maxResponseBytes: 16_000_000,
    fixedEndpoint: { id: "sslbl", endpoint: ENDPOINT, pathPrefix: "/blacklist" },
  }
  try {
    return await fetchText(url, request)
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the SSLBL blacklist${status}; check network access and retry later`)
  }
}

export const Sslbl: Integration = {
  id: "sslbl",
  category: "data",
  description: "Check certificate fingerprints and IPs against the SSLBL abuse.ch blacklists",
  tools: [
    {
      name: "sslbl_certificate_lookup",
      description: "Check a SHA-1 TLS certificate fingerprint against the cached SSLBL certificate blacklist.",
      inputSchema: {
        type: "object",
        properties: { sha1: { type: "string", description: "40-character SHA-1 certificate fingerprint" } },
        required: ["sha1"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (typeof args.sha1 !== "string" || !SHA1_RE.test(args.sha1.trim())) {
          throw new ToolError('"sha1" must be a 40-character hexadecimal SHA-1 certificate fingerprint')
        }
        const sha1 = args.sha1.trim().toUpperCase()
        const entries = parseSslblCertificates(await loadFeed(CERTIFICATE_FEED, "sslbl-certificates", ctx))
        const matches = entries.filter((entry) => entry.sha1 === sha1)
        return {
          source: SOURCE,
          sha1,
          listed: matches.length > 0,
          totalMatches: matches.length,
          matches: matches.slice(0, MAX_MATCHES),
        }
      },
    },
    {
      name: "sslbl_ip_lookup",
      description:
        "Check an IP against the cached SSLBL botnet C2 IP blacklist. The listed destination is never contacted.",
      inputSchema: {
        type: "object",
        properties: { ip: { type: "string", description: "IPv4 or IPv6 address to check" } },
        required: ["ip"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (typeof args.ip !== "string" || isIP(args.ip.trim()) === 0) {
          throw new ToolError('"ip" must be a valid IPv4 or IPv6 address')
        }
        const ip = args.ip.trim().toLowerCase()
        const entries = parseSslblIps(await loadFeed(IP_FEED, "sslbl-ips", ctx))
        const matches = entries.filter((entry) => entry.ip === ip)
        return {
          source: SOURCE,
          ip,
          listed: matches.length > 0,
          totalMatches: matches.length,
          matches: matches.slice(0, MAX_MATCHES),
        }
      },
    },
  ],
}
