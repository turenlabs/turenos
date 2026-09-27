import { DomUtils, parseDocument } from "htmlparser2"
import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../registry"
import { ToolError, type IntegrationContext } from "../types"
import { fetchText, HttpError } from "../util/http"

const FEED_URL = ExtensionCatalog.dataEndpoint("security:cert-eu", "feed")
const FIXED_ENDPOINT = {
  id: "cert-eu",
  endpoint: FEED_URL,
  pathPrefix: "/publications/security-advisories-rss",
}
const CACHE_TTL_MS = 60 * 60_000
const MAX_FEED_BYTES = 256 * 1024
const MAX_FEED_ENTRIES = 10
const MAX_QUERY_CHARS = 120
const MAX_SUMMARY_CHARS = 600
const MAX_RESULTS = 10
const SOURCE_INFO = {
  source: "CERT-EU Security Advisories",
  attribution: "CERT-EU, Security Advisories",
  license: "Creative Commons Attribution 4.0 International (CC BY 4.0), unless otherwise noted",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  termsUrl: "https://cert.europa.eu/legal-notice",
  changes: "Feed HTML was removed and descriptions were whitespace-normalized and truncated to 600 characters.",
  disclaimer: "CERT-EU notes its information may be incomplete or out of date and is not professional or legal advice.",
}

interface Advisory {
  id: string
  title: string
  summary?: string
  published?: string
  url: string
}

type XmlElement = ReturnType<typeof DomUtils.getElementsByTagName>[number]

function children(element: XmlElement, name: string) {
  return DomUtils.getElementsByTagName(name, element.children, false)
}

function compact(value: string, max: number) {
  const normalized = value.replaceAll(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function nodeText(element: XmlElement, name: string) {
  const node = children(element, name)[0]
  return node ? DomUtils.textContent(node).trim() || undefined : undefined
}

function plainSummary(value: string) {
  const html = parseDocument(value.replaceAll(/<br\s*\/?>/gi, "\n").replaceAll(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n"), {
    decodeEntities: true,
  })
  for (const tag of ["script", "style"]) {
    for (const node of DomUtils.getElementsByTagName(tag, html.children)) DomUtils.removeElement(node)
  }
  return compact(DomUtils.textContent(html.children), MAX_SUMMARY_CHARS) || undefined
}

function parseAdvisories(xml: string): Advisory[] {
  const document = parseDocument(xml, { xmlMode: true, decodeEntities: true })
  const roots = DomUtils.getElementsByTagName("rss", document.children, false)
  const root = roots[0]
  const channels = root ? children(root, "channel") : []
  const channel = channels[0]
  const items = channel ? children(channel, "item") : []
  const advisories = items.flatMap((item): Advisory[] => {
    const sourceLink = nodeText(item, "link")
    const id = sourceLink?.match(
      /^https:\/\/cert\.europa\.eu\/publications\/security-advisories\/(\d{4}-\d{3})\/?$/i,
    )?.[1]
    const title = nodeText(item, "title")
    if (!id || !title) return []
    const rawSummary = nodeText(item, "description")
    const summary = rawSummary ? plainSummary(rawSummary) : undefined
    const published = nodeText(item, "pubDate")
    return [
      {
        id,
        title: compact(title, 240),
        ...(summary ? { summary } : {}),
        ...(published ? { published: compact(published, 80) } : {}),
        url: `https://cert.europa.eu/publications/security-advisories/${id}/`,
      },
    ]
  })
  const ids = advisories.map((advisory) => advisory.id)
  if (
    roots.length !== 1 ||
    root?.attribs.version !== "2.0" ||
    channels.length !== 1 ||
    !xml.trimEnd().endsWith("</rss>") ||
    items.length === 0 ||
    items.length > MAX_FEED_ENTRIES ||
    advisories.length !== items.length ||
    new Set(ids).size !== ids.length
  ) {
    throw new ToolError("CERT-EU returned an invalid security advisory feed; check network access and retry later")
  }
  return advisories
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireID(raw: unknown) {
  const match = typeof raw === "string" ? raw.trim().match(/^(?:CERT-EU-SA)?(\d{4}-\d{3})$/i) : undefined
  if (!match) throw new ToolError('"id" must be a CERT-EU advisory id such as "2026-013"')
  return match[1]!
}

function requireQuery(raw: unknown) {
  if (typeof raw !== "string" || raw.trim().length < 2 || raw.trim().length > MAX_QUERY_CHARS) {
    throw new ToolError(`"query" must contain between 2 and ${MAX_QUERY_CHARS} characters`)
  }
  return raw.trim()
}

function parseLimit(raw: unknown) {
  const limit = raw ?? MAX_RESULTS
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return limit
}

function isValidFeed(value: unknown) {
  if (typeof value !== "string") throw new ToolError("CERT-EU returned a non-text advisory feed")
  parseAdvisories(value)
}

async function loadAdvisories(ctx: IntegrationContext) {
  let xml: string
  try {
    xml = await fetchText(FEED_URL, {
      fixedEndpoint: FIXED_ENDPOINT,
      cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "cert-eu-security-advisories", validate: isValidFeed },
      maxResponseBytes: MAX_FEED_BYTES,
    })
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download CERT-EU security advisories${status}; check network access and retry later`)
  }
  return parseAdvisories(xml)
}

function result(advisory: Advisory) {
  return {
    id: advisory.id,
    title: advisory.title,
    ...(advisory.summary ? { summary: advisory.summary } : {}),
    ...(advisory.published ? { published: advisory.published } : {}),
    url: advisory.url,
  }
}

export const CertEu: Integration = {
  id: "cert-eu",
  category: "data",
  description: "Search the ten latest CERT-EU security advisories for vulnerability and mitigation summaries",
  tools: [
    {
      name: "cert_eu_advisory_lookup",
      description:
        "Look up one of the ten latest CERT-EU security advisories by id; returns an attributed summary and source link.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^(CERT-EU-SA)?[0-9]{4}-[0-9]{3}$",
            description: 'Advisory id, for example "2026-013"',
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id"])
        const id = requireID(args.id)
        const advisory = (await loadAdvisories(ctx)).find((entry) => entry.id === id)
        if (!advisory) throw new ToolError(`CERT-EU advisory ${id} was not found among the ten latest feed entries`)
        return { ...SOURCE_INFO, advisory: result(advisory) }
      },
    },
    {
      name: "cert_eu_advisory_search",
      description:
        "Search the ten latest CERT-EU security advisories by id, title, or summary; returns at most ten results.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: MAX_QUERY_CHARS },
          limit: { type: "number", minimum: 1, maximum: MAX_RESULTS },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["query", "limit"])
        const query = requireQuery(args.query)
        const limit = parseLimit(args.limit)
        const needle = query.toLowerCase()
        const matches = (await loadAdvisories(ctx)).filter((advisory) =>
          `${advisory.id} ${advisory.title} ${advisory.summary ?? ""}`.toLowerCase().includes(needle),
        )
        return {
          ...SOURCE_INFO,
          query,
          total: matches.length,
          returned: Math.min(matches.length, limit),
          results: matches.slice(0, limit).map(result),
        }
      },
    },
  ],
}

export { parseAdvisories }
