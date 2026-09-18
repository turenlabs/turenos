import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const ENDPOINT = ExtensionCatalog.dataEndpoint("security:tweetfeed")
const PATH = "/v1/ioc"
const CACHE_TTL_MS = 3_600_000
const MAX_IOC_LENGTH = 2_048
const MAX_RECORDS = 10

type JsonObject = Record<string, unknown>

function object(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function strings(value: unknown, maximum: number) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, maximum)
        .map((item) => item.slice(0, 500))
    : []
}

function parseRecord(value: unknown) {
  const record = object(value)
  if (!record || typeof record.value !== "string" || typeof record.type !== "string") return undefined
  const related = Array.isArray(record.related)
    ? record.related
        .flatMap((item) =>
          Array.isArray(item) && item.length === 2 && item.every((part) => typeof part === "string")
            ? [[String(item[0]).slice(0, 80), String(item[1]).slice(0, 500)]]
            : [],
        )
        .slice(0, 20)
    : []
  return {
    value: record.value.slice(0, 2_048),
    type: record.type.slice(0, 80),
    ...(typeof record.count === "number" && Number.isSafeInteger(record.count) ? { count: record.count } : {}),
    ...(typeof record.first_seen === "string" ? { firstSeen: record.first_seen.slice(0, 80) } : {}),
    ...(typeof record.last_seen === "string" ? { lastSeen: record.last_seen.slice(0, 80) } : {}),
    ...(related.length ? { related } : {}),
    tags: strings(record.tags, 20),
    reporters: strings(record.users, 20),
    provenance: strings(record.tweets, 20),
  }
}

function matchesIndicator(value: string, expected: string) {
  if (value.toLowerCase() === expected.toLowerCase()) return true
  try {
    return new URL(value).hostname.toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

export function parseTweetFeed(value: unknown, expected: string) {
  const response = object(value)
  if (!response || typeof response.found !== "boolean" || typeof response.query !== "string") {
    throw new ToolError("TweetFeed returned an unexpected response; retry later")
  }
  if (!Array.isArray(response.records)) throw new ToolError("TweetFeed response did not include records; retry later")
  if (response.query.toLowerCase() !== expected.toLowerCase()) {
    throw new ToolError("TweetFeed response did not match the requested IOC; refusing false attribution")
  }
  const records = response.records.flatMap((record) => {
    const parsed = parseRecord(record)
    return parsed ? [parsed] : []
  })
  if (response.found && records.length === 0) {
    throw new ToolError("TweetFeed marked the IOC found but returned no valid records; retry later")
  }
  if (response.found && !records.some((record) => matchesIndicator(record.value, expected))) {
    throw new ToolError("TweetFeed positive records did not match the requested IOC; refusing false attribution")
  }
  return {
    found: response.found,
    query: response.query.slice(0, MAX_IOC_LENGTH),
    ...(typeof response.window === "string" ? { window: response.window.slice(0, 40) } : {}),
    records: records.slice(0, MAX_RECORDS),
    recordsTotal: records.length,
  }
}

async function lookup(ctx: IntegrationContext, ioc: string) {
  try {
    return parseTweetFeed(
      await fetchJson(`${ENDPOINT}${PATH}?value=${encodeURIComponent(ioc)}`, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
        fixedEndpoint: { id: "tweetfeed", endpoint: ENDPOINT, pathPrefix: PATH },
        maxResponseBytes: 2 * 1024 * 1024,
      }),
      ioc,
    )
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`TweetFeed lookup failed${status}; retry later`)
  }
}

export const TweetFeed: Integration = {
  id: "tweetfeed",
  category: "data",
  description: "Look up community-reported IOCs in TweetFeed's CC0 rolling feed",
  tools: [
    {
      name: "tweetfeed_lookup",
      description:
        "Look up one exact IOC in TweetFeed. Results are unvetted social-media watchlist context and require corroboration before action.",
      inputSchema: {
        type: "object",
        properties: { ioc: { type: "string", description: "Exact IP, domain, URL, or hash" } },
        required: ["ioc"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        if (typeof args.ioc !== "string" || args.ioc.trim() === "" || args.ioc.length > MAX_IOC_LENGTH) {
          throw new ToolError(`"ioc" must contain between 1 and ${MAX_IOC_LENGTH} characters`)
        }
        const result = await lookup(ctx, args.ioc.trim())
        return {
          source: "TweetFeed",
          license: "CC0-1.0",
          caution:
            "Raw community-reported intelligence; not-found is unknown and a match is not an automatic block verdict.",
          ...result,
        }
      },
    },
  ],
}
