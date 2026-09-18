import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const ENDPOINT = ExtensionCatalog.dataEndpoint("security:certfr-misp")
const FEED_PATH = "/feed-misp"
const MANIFEST_URL = `${ENDPOINT}${FEED_PATH}/manifest.json`
const FIXED_ENDPOINT = { id: "certfr-misp", endpoint: ENDPOINT, pathPrefix: FEED_PATH }
const ATTRIBUTION = "CERT-FR / ANSSI"
const LICENSE = "Open Licence 2.0"
const MANIFEST_TTL_MS = 3_600_000
const EVENT_TTL_MS = 24 * 3_600_000
const DEFAULT_RESULTS = 10
const MAX_RESULTS = 20
const MAX_ATTRIBUTES = 75
const MAX_QUERY_CHARS = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

type JsonObject = Record<string, unknown>

type SourceOrg = {
  name: string
  uuid?: string
}

type ManifestEvent = {
  uuid: string
  info: string
  date: string
  sourceOrg: SourceOrg
  tags: string[]
  tlp: string[]
  pap: string[]
  lastUpdate: string
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function requireObject(value: unknown, location: string) {
  const record = object(value)
  if (!record) throw malformed(`${location} must be an object`)
  return record
}

function requireString(record: JsonObject, key: string, location: string, max: number) {
  const value = record[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw malformed(`${location}.${key} must be a non-empty string`)
  }
  return clip(value.trim(), max)
}

function optionalString(record: JsonObject, key: string, location: string, max: number) {
  const value = record[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw malformed(`${location}.${key} must be a string`)
  return clip(value.trim(), max)
}

function scalarString(record: JsonObject, key: string, location: string) {
  const value = record[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "string" && value.trim() !== "") return clip(value.trim(), 80)
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value)
  throw malformed(`${location}.${key} must be a string or non-negative integer`)
}

function booleanValue(value: unknown, location: string, optional = false): boolean | undefined {
  if (optional && (value === undefined || value === null || value === "")) return undefined
  if (value === true || value === 1 || value === "1") return true
  if (value === false || value === 0 || value === "0") return false
  throw malformed(`${location} must be a boolean`)
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function malformed(detail: string): ToolError {
  return new ToolError(
    `CERT-FR MISP feed had an unexpected shape (${detail}); refusing the data and retrying later may help`,
  )
}

function parseOrg(value: unknown, location: string): SourceOrg {
  const record = requireObject(value, location)
  const name = requireString(record, "name", location, 120)
  const uuid = optionalString(record, "uuid", location, 36)
  if (uuid !== undefined && !UUID.test(uuid)) throw malformed(`${location}.uuid is not a UUID`)
  return { name, ...(uuid ? { uuid: uuid.toLowerCase() } : {}) }
}

function parseTags(value: unknown, location: string) {
  if (!Array.isArray(value)) throw malformed(`${location} must be an array`)
  return value.map((entry, index) =>
    requireString(requireObject(entry, `${location}[${index}]`), "name", `${location}[${index}]`, 160),
  )
}

function requireClearPolicy(uuid: string, sourceOrg: SourceOrg, tags: readonly string[]) {
  if (sourceOrg.name.toUpperCase() !== "CERT-FR") {
    throw new ToolError(`MISP event "${uuid}" is not sourced by CERT-FR; refusing to disclose it`)
  }
  if (!tags.some((tag) => tag.toLowerCase() === "tlp:clear")) {
    throw new ToolError(`MISP event "${uuid}" is not marked TLP:CLEAR; refusing to disclose it`)
  }
  return {
    tlp: tags.filter((tag) => tag.toLowerCase().startsWith("tlp:")),
    pap: tags.filter((tag) => tag.toLowerCase().startsWith("pap:")),
  }
}

function lastUpdate(record: JsonObject, location: string, fallback: string) {
  return (
    scalarString(record, "timestamp", location) ??
    scalarString(record, "publish_timestamp", location) ??
    scalarString(record, "published_timestamp", location) ??
    fallback
  )
}

export function parseManifest(value: unknown) {
  const manifest = requireObject(value, "manifest")
  const events = Object.entries(manifest).map(([rawUuid, value]) => {
    if (!UUID.test(rawUuid)) throw malformed(`manifest key "${rawUuid}" is not a UUID`)
    const uuid = rawUuid.toLowerCase()
    const location = `manifest[${uuid}]`
    const record = requireObject(value, location)
    const info = requireString(record, "info", location, 500)
    const date = requireString(record, "date", location, 10)
    if (!DATE.test(date)) throw malformed(`${location}.date is not YYYY-MM-DD`)
    const sourceOrg = parseOrg(record.Orgc, `${location}.Orgc`)
    const tags = parseTags(record.Tag, `${location}.Tag`)
    const policy = requireClearPolicy(uuid, sourceOrg, tags)
    return {
      uuid,
      info,
      date,
      sourceOrg,
      tags: tags.slice(0, 50),
      tlp: policy.tlp,
      pap: policy.pap,
      lastUpdate: lastUpdate(record, location, date),
    }
  })
  if (events.length === 0) throw malformed("manifest contained no events")
  return events
}

async function loadManifest(ctx: IntegrationContext) {
  try {
    return parseManifest(
      await fetchJson(MANIFEST_URL, {
        cache: { dir: ctx.cacheDir, ttlMs: MANIFEST_TTL_MS, key: "manifest" },
        fixedEndpoint: FIXED_ENDPOINT,
        maxResponseBytes: 4 * 1024 * 1024,
      }),
    )
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download the CERT-FR MISP manifest${status}; check network access and retry later`)
  }
}

function requireUuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    throw new ToolError('"uuid" must be a canonical UUID such as "12345678-1234-1234-1234-123456789abc"')
  }
  return value.trim().toLowerCase()
}

function parseLimit(value: unknown) {
  const limit = value ?? DEFAULT_RESULTS
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return limit
}

function requireQuery(value: unknown) {
  if (typeof value !== "string") throw new ToolError('"query" must be a string')
  const query = value.trim()
  if (query === "" || query.length > MAX_QUERY_CHARS) {
    throw new ToolError(`"query" must contain between 1 and ${MAX_QUERY_CHARS} characters`)
  }
  return query
}

function summarize(event: ManifestEvent) {
  return {
    uuid: event.uuid,
    info: event.info,
    date: event.date,
    sourceOrg: event.sourceOrg,
    tags: event.tags,
    tlp: event.tlp,
    pap: event.pap,
    lastUpdate: event.lastUpdate,
  }
}

function parseAttribute(value: unknown, location: string, objectAttribute: boolean) {
  const record = requireObject(value, location)
  const deleted = booleanValue(record.deleted, `${location}.deleted`, true) ?? false
  if (deleted) return undefined
  const type = requireString(record, "type", location, 100)
  const category = requireString(record, "category", location, 120)
  const attributeValue = requireString(record, "value", location, 500)
  const comment = optionalString(record, "comment", location, 240)
  const toIds = booleanValue(record.to_ids, `${location}.to_ids`)
  const objectRelation = optionalString(record, "object_relation", location, 120)
  if (objectAttribute && !objectRelation) throw malformed(`${location}.object_relation must be a non-empty string`)
  return {
    type,
    category,
    value: attributeValue,
    ...(comment ? { comment } : {}),
    toIds,
    ...(objectRelation ? { objectRelation } : {}),
  }
}

function parseAttributeArray(value: unknown, location: string, objectAttribute: boolean) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw malformed(`${location} must be an array`)
  return value
    .map((entry, index) => parseAttribute(entry, `${location}[${index}]`, objectAttribute))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
}

function parseAttributes(event: JsonObject, location: string) {
  const direct = parseAttributeArray(event.Attribute, `${location}.Attribute`, false)
  if (event.Object !== undefined && !Array.isArray(event.Object)) throw malformed(`${location}.Object must be an array`)
  const nested = (event.Object ?? []).flatMap((value, index) => {
    const objectLocation = `${location}.Object[${index}]`
    const record = requireObject(value, objectLocation)
    if (booleanValue(record.deleted, `${objectLocation}.deleted`, true) === true) return []
    return parseAttributeArray(record.Attribute, `${objectLocation}.Attribute`, true)
  })
  return [...direct, ...nested]
}

export function parseEvent(value: unknown, requestedUuid: string) {
  const root = requireObject(value, "response")
  const event = requireObject(root.Event, "response.Event")
  const uuid = requireString(event, "uuid", "response.Event", 36).toLowerCase()
  if (!UUID.test(uuid) || uuid !== requestedUuid) {
    throw malformed("response.Event.uuid did not match the requested UUID")
  }
  const info = requireString(event, "info", "response.Event", 500)
  const date = requireString(event, "date", "response.Event", 10)
  if (!DATE.test(date)) throw malformed("response.Event.date is not YYYY-MM-DD")
  const sourceOrg = parseOrg(event.Orgc, "response.Event.Orgc")
  const tags = parseTags(event.Tag, "response.Event.Tag")
  const policy = requireClearPolicy(uuid, sourceOrg, tags)
  const published = booleanValue(event.published, "response.Event.published", true)
  const attributes = parseAttributes(event, "response.Event")
  const publishTimestamp = scalarString(event, "publish_timestamp", "response.Event")
  const analysis = scalarString(event, "analysis", "response.Event")
  const threatLevelId = scalarString(event, "threat_level_id", "response.Event")
  const distribution = scalarString(event, "distribution", "response.Event")
  return {
    uuid,
    info,
    date,
    sourceOrg,
    tags: tags.slice(0, 50),
    tlp: policy.tlp,
    pap: policy.pap,
    lastUpdate: lastUpdate(event, "response.Event", date),
    ...(published !== undefined ? { published } : {}),
    ...(publishTimestamp ? { publishTimestamp } : {}),
    ...(analysis ? { analysis } : {}),
    ...(threatLevelId ? { threatLevelId } : {}),
    ...(distribution ? { distribution } : {}),
    attributes: attributes.slice(0, MAX_ATTRIBUTES),
    attributesTotal: attributes.length,
    attributesTruncated: attributes.length > MAX_ATTRIBUTES || undefined,
  }
}

async function loadEvent(ctx: IntegrationContext, uuid: string) {
  try {
    return parseEvent(
      await fetchJson(`${ENDPOINT}${FEED_PATH}/${uuid}.json`, {
        cache: { dir: ctx.cacheDir, ttlMs: EVENT_TTL_MS, key: `event-${uuid}` },
        fixedEndpoint: FIXED_ENDPOINT,
        maxResponseBytes: 8 * 1024 * 1024,
      }),
      uuid,
    )
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof HttpError && error.status === 404) {
      throw new ToolError(`CERT-FR MISP event "${uuid}" was not found; check the UUID`)
    }
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(
      `failed to download CERT-FR MISP event "${uuid}"${status}; check network access and retry later`,
    )
  }
}

export const CertFrMisp: Integration = {
  id: "certfr-misp",
  category: "data",
  description: "Search and inspect TLP:CLEAR threat events from the CERT-FR MISP feed",
  tools: [
    {
      name: "certfr_misp_search",
      description:
        "Search the cached CERT-FR/ANSSI MISP manifest by event title, date, tags, or source organisation. IOC values are never contacted.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: `Search text (1-${MAX_QUERY_CHARS} characters)` },
          limit: {
            type: "number",
            description: `Maximum UUID summaries (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["query", "limit"])
        const query = requireQuery(args.query)
        const limit = parseLimit(args.limit)
        const needle = query.toLowerCase()
        const manifest = await loadManifest(ctx)
        const matches = manifest
          .filter((event) =>
            [event.info, event.date, event.sourceOrg.name, ...event.tags].join("\n").toLowerCase().includes(needle),
          )
          .toSorted((left, right) => right.date.localeCompare(left.date) || left.uuid.localeCompare(right.uuid))
        return {
          source: ATTRIBUTION,
          license: LICENSE,
          lastUpdate: manifest
            .map((event) => event.lastUpdate)
            .toSorted()
            .at(-1),
          query,
          total: matches.length,
          events: matches.slice(0, limit).map(summarize),
          truncated: matches.length > limit || undefined,
        }
      },
    },
    {
      name: "certfr_misp_event",
      description:
        "Fetch one TLP:CLEAR CERT-FR/ANSSI MISP event by UUID and return compact metadata plus at most 75 non-deleted attributes. IOC values are returned as data and never contacted.",
      inputSchema: {
        type: "object",
        properties: { uuid: { type: "string", description: "Canonical MISP event UUID" } },
        required: ["uuid"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["uuid"])
        const event = await loadEvent(ctx, requireUuid(args.uuid))
        return {
          source: ATTRIBUTION,
          license: LICENSE,
          lastUpdate: event.lastUpdate,
          event,
        }
      },
    },
  ],
}
