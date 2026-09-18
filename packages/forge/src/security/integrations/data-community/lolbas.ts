import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const FEED_URL = ExtensionCatalog.dataEndpoint("security:lolbas", "feed")
const SITE_URL = ExtensionCatalog.dataEndpoint("security:lolbas", "site")
const CACHE_TTL_MS = 24 * 3_600_000
const DEFAULT_LIMIT = 10
const MAX_RESULTS = 20
const ATTRIBUTION = "LOLBAS Project (GPL-3.0)"

type JsonObject = Record<string, unknown>

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

function resultLimit(args: Record<string, unknown>) {
  const value = args.limit ?? DEFAULT_LIMIT
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return value
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

function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = object(entry)
    return record ? [record] : []
  })
}

function feedEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return objects(value)
  const root = object(value)
  if (!root) return []
  const nested = root.entries ?? root.lolbas ?? root.data
  if (Array.isArray(nested)) return objects(nested)
  return Object.entries(root).flatMap(([entryName, entry]) => {
    const record = object(entry)
    return record ? [{ Name: text(record, "Name", "name") ?? entryName, ...record }] : []
  })
}

async function loadFeed(ctx: IntegrationContext) {
  try {
    const entries = feedEntries(
      await fetchJson(FEED_URL, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: "lolbas-feed" },
        fixedEndpoint: { id: "lolbas", endpoint: FEED_URL, pathPrefix: "/api/lolbas.json" },
        maxResponseBytes: 8 * 1024 * 1024,
      }),
    )
    if (entries.length === 0) throw new ToolError("LOLBAS feed had an unexpected shape; retry later")
    return entries
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the LOLBAS feed${status}; check network access and retry later`)
  }
}

function entryName(record: JsonObject) {
  return text(record, "Name", "name", "Binary", "binary")
}

function sourceUrl(record: JsonObject) {
  const explicit = text(record, "URL", "Url", "url", "Link", "link")
  if (explicit?.startsWith(SITE_URL)) return explicit
  const stem = (entryName(record) ?? "").replace(/\.[^.]+$/, "")
  return `${SITE_URL}lolbas/Binaries/${encodeURIComponent(stem)}/`
}

function unique(values: (string | undefined)[], max: number) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, max)
}

function summarize(record: JsonObject, exampleLimit: number) {
  const commands = objects(record.Commands ?? record.commands)
  const paths = objects(record.Full_Path ?? record.full_path ?? record.paths)
  const description = text(record, "Description", "description")
  return {
    name: entryName(record),
    ...(description ? { description: clip(description, 220) } : {}),
    categories: unique(
      commands.map((command) => text(command, "Category", "category")),
      8,
    ),
    useCases: unique(
      commands.map((command) => text(command, "Usecase", "usecase", "Description", "description")),
      5,
    ).map((value) => clip(value, 120)),
    privileges: unique(
      commands.map((command) => text(command, "Privileges", "privileges")),
      4,
    ),
    mitreTechniques: unique(
      commands.map((command) => text(command, "MitreID", "mitreId", "mitre_id")),
      5,
    ),
    paths: paths
      .flatMap((path) => {
        const value = text(path, "Path", "path")
        return value ? [clip(value, 120)] : []
      })
      .slice(0, 3),
    ...(exampleLimit > 0
      ? {
          examples: commands
            .flatMap((command) => {
              const value = text(command, "Command", "command")
              return value
                ? [
                    {
                      command: clip(value, 300),
                      category: text(command, "Category", "category"),
                      useCase: text(command, "Usecase", "usecase"),
                    },
                  ]
                : []
            })
            .slice(0, exampleLimit),
        }
      : {}),
    sourceUrl: sourceUrl(record),
  }
}

function normalizedBinary(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
}

export const Lolbas: Integration = {
  id: "lolbas",
  category: "data",
  description: "Search the official LOLBAS catalog for Windows living-off-the-land binaries",
  tools: [
    {
      name: "lolbas_lookup",
      description: "Look up a LOLBAS entry by binary name. Returns reference data only and never executes commands.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: 'Binary name, e.g. "certutil.exe"' } },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["name"])
        const query = requiredString(args, "name", 100)
        const entry = (await loadFeed(ctx)).find((candidate) => {
          const candidateName = entryName(candidate)
          return candidateName ? normalizedBinary(candidateName) === normalizedBinary(query) : false
        })
        if (!entry)
          throw new ToolError(`LOLBAS has no entry for "${query}"; check the binary name or use lolbas_search`)
        return { source: ATTRIBUTION, informationalOnly: true, entry: summarize(entry, 6) }
      },
    },
    {
      name: "lolbas_search",
      description:
        "Search LOLBAS names, descriptions, categories, and use cases. Returns at most 20 references; never executes commands.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Binary name, capability, category, or use case" },
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
        const matches = (await loadFeed(ctx)).filter((entry) => {
          const commands = objects(entry.Commands ?? entry.commands)
          return [
            entryName(entry),
            text(entry, "Description", "description"),
            ...commands.flatMap((command) => [
              text(command, "Category", "category"),
              text(command, "Usecase", "usecase"),
              text(command, "Description", "description"),
            ]),
          ].some((value) => value?.toLowerCase().includes(needle))
        })
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
