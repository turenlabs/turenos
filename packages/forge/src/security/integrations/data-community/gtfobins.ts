import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const FEED_URL = ExtensionCatalog.dataEndpoint("security:gtfobins")
const CACHE_TTL_MS = 24 * 3_600_000
const DEFAULT_LIMIT = 10
const MAX_RESULTS = 20
const ATTRIBUTION = "GTFOBins (GPL-3.0)"

type JsonObject = Record<string, unknown>
type Entry = { name: string; record: JsonObject }

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requiredString(args: Record<string, unknown>, key: string, max: number) {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`"${key}" must be a non-empty string`)
  if (value.trim().length > max) throw new ToolError(`"${key}" must be at most ${max} characters`)
  return value.trim()
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function text(record: JsonObject, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "string")
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function entries(value: unknown): Entry[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const record = object(item)
      const name = record ? text(record, "name", "binary", "bin") : undefined
      return record && name ? [{ name, record }] : []
    })
  }
  const root = object(value)
  if (!root) return []
  const nested = root.executables ?? root.bins ?? root.entries ?? root.data
  if (nested !== undefined && nested !== value) {
    const parsed = entries(nested)
    if (parsed.length > 0) return parsed
  }
  return Object.entries(root).flatMap(([name, item]) => {
    const record = object(item)
    if (record) return [{ name, record }]
    return Array.isArray(item) ? [{ name, record: { functions: item } }] : []
  })
}

async function loadFeed(ctx: IntegrationContext) {
  try {
    const result = entries(
      await fetchJson(FEED_URL, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "gtfobins-feed" },
        fixedEndpoint: { id: "gtfobins", endpoint: FEED_URL, pathPrefix: "/api.json" },
        maxResponseBytes: 4 * 1024 * 1024,
      }),
    )
    if (result.length === 0) throw new ToolError("GTFOBins feed had an unexpected shape; retry later")
    return result
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the GTFOBins feed${status}; check network access and retry later`)
  }
}

function functions(record: JsonObject): [string, unknown][] {
  const raw = record.functions ?? record.Functions
  const value = object(raw)
  if (value) return Object.entries(value)
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim() !== "") return [[entry.trim(), undefined] as [string, unknown]]
    const item = object(entry)
    const name = item ? text(item, "name", "function", "type") : undefined
    return item && name ? [[name, item.examples ?? item.commands ?? item.code] as [string, unknown]] : []
  })
}

function codeExamples(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim() !== "") return [clip(entry.trim(), 300)]
    const item = object(entry)
    const code = item ? text(item, "code", "command", "example") : undefined
    return code ? [clip(code, 300)] : []
  })
}

function summarize(entry: Entry, exampleLimit: number) {
  const capabilities = functions(entry.record)
  const description = text(entry.record, "description", "Description")
  return {
    name: entry.name,
    ...(description ? { description: clip(description, 300) } : {}),
    functions: capabilities.map(([name]) => name).slice(0, 20),
    ...(exampleLimit > 0
      ? {
          examples: capabilities
            .flatMap(([capability, examples]) => codeExamples(examples).map((code) => ({ capability, code })))
            .slice(0, exampleLimit),
        }
      : {}),
    sourceUrl: `https://gtfobins.org/gtfobins/${encodeURIComponent(entry.name.toLowerCase())}/`,
  }
}

function resultLimit(args: Record<string, unknown>) {
  const value = args.limit ?? DEFAULT_LIMIT
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return value
}

export const Gtfobins: Integration = {
  id: "gtfobins",
  category: "data",
  description: "Search the official GTFOBins catalog for Unix living-off-the-land binaries",
  tools: [
    {
      name: "gtfobins_lookup",
      description:
        "Look up a GTFOBins binary and its documented capabilities. Returns reference data only and never executes commands.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: 'Binary name, e.g. "awk"' } },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["name"])
        const query = requiredString(args, "name", 100)
        const entry = (await loadFeed(ctx)).find((candidate) => candidate.name.toLowerCase() === query.toLowerCase())
        if (!entry) {
          throw new ToolError(`GTFOBins has no entry for "${query}"; check the binary name or use gtfobins_search`)
        }
        return { source: ATTRIBUTION, informationalOnly: true, entry: summarize(entry, 8) }
      },
    },
    {
      name: "gtfobins_search",
      description:
        "Search GTFOBins by binary, function, or description. Returns at most 20 references and never executes commands.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Binary name or capability such as shell, sudo, or file-read" },
          limit: { type: "number", description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_RESULTS})` },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["query", "limit"])
        const query = requiredString(args, "query", 100)
        const max = resultLimit(args)
        const needle = query.toLowerCase()
        const matches = (await loadFeed(ctx)).filter((entry) =>
          [
            entry.name,
            text(entry.record, "description", "Description"),
            ...functions(entry.record).map(([name]) => name),
          ].some((value) => value?.toLowerCase().includes(needle)),
        )
        return {
          source: ATTRIBUTION,
          informationalOnly: true,
          query,
          total: matches.length,
          results: matches.slice(0, max).map((entry) => summarize(entry, 0)),
          truncated: matches.length > max || undefined,
        }
      },
    },
  ],
}
