import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

/** MITRE D3FEND versioned JSON-LD ontology. */

const VERSION = "1.5.0"
const ONTOLOGY_URL = `https://d3fend.mitre.org/ontologies/d3fend/${VERSION}/d3fend.json`
const FIXED_ENDPOINT = {
  id: "d3fend",
  endpoint: ONTOLOGY_URL,
  pathPrefix: `/ontologies/d3fend/${VERSION}/`,
}
const SOURCE = "MITRE D3FEND"
const ONTOLOGY_TTL_MS = 24 * 3_600_000
const MAX_QUERY_CHARS = 120
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 10
const MAX_DEFINITION_CHARS = 600

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function graphOf(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isObject)
  if (!isObject(value)) return []
  const graph = value["@graph"]
  if (Array.isArray(graph)) return graph.filter(isObject)
  return isObject(graph) ? [graph] : []
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(scalarStrings)
  if (!isObject(value)) return []
  const literal = value["@value"]
  if (typeof literal === "string") return [literal]
  const id = value["@id"]
  return typeof id === "string" ? [id] : []
}

function localName(value: string) {
  return (
    value
      .split(/[\/#:]/)
      .at(-1)
      ?.toLowerCase() ?? value.toLowerCase()
  )
}

function fieldValues(object: JsonObject, names: readonly string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return Object.entries(object).flatMap(([key, value]) => (wanted.has(localName(key)) ? scalarStrings(value) : []))
}

function iriOf(object: JsonObject) {
  return scalarStrings(object["@id"])[0]
}

function fragmentOf(iri: string | undefined) {
  return iri?.split(/[\/#]/).at(-1)
}

function d3fendID(object: JsonObject) {
  const values = Object.entries(object).flatMap(([key, value]) => {
    const name = localName(key)
    if (key === "@id" || (!name.includes("id") && !name.includes("identifier"))) return []
    return scalarStrings(value)
  })
  return values.find((value) => /^D3-[A-Z0-9-]+$/i.test(value))
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const compact = text.replaceAll(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function clippedStrings(values: readonly string[], max: number, count: number) {
  return values
    .slice(0, count)
    .map((value) => clip(value, max))
    .filter((value): value is string => value !== undefined)
}

function summarize(object: JsonObject) {
  const iri = iriOf(object)
  const id = d3fendID(object)
  const label = fieldValues(object, ["label", "prefLabel", "title"])[0]
  const definition = fieldValues(object, ["definition", "comment", "description"])[0]
  const alternateLabels = clippedStrings(fieldValues(object, ["altLabel", "alternativeLabel", "synonym"]), 240, 8)
  const types = clippedStrings(
    scalarStrings(object["@type"]).map((type) => fragmentOf(type) ?? type),
    120,
    8,
  )
  return {
    ...(id ? { id: clip(id, 80) } : {}),
    ...(label ? { name: clip(label, 240) } : {}),
    ...(definition ? { definition: clip(definition, MAX_DEFINITION_CHARS) } : {}),
    ...(alternateLabels.length ? { alternateLabels } : {}),
    ...(types.length ? { types } : {}),
    ...(iri ? { iri: clip(iri, 500) } : {}),
  }
}

async function loadOntology(ctx: IntegrationContext) {
  let ontology: unknown
  try {
    ontology = await fetchJson(ONTOLOGY_URL, {
      fixedEndpoint: FIXED_ENDPOINT,
      cache: { dir: ctx.cacheDir, ttlMs: ONTOLOGY_TTL_MS, key: `d3fend-${VERSION}` },
    })
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download MITRE D3FEND ${VERSION}${status}; check network access and retry`)
  }
  const graph = graphOf(ontology)
  if (graph.length === 0) {
    throw new ToolError(`MITRE D3FEND ${VERSION} had an unexpected JSON-LD @graph shape; retry later`)
  }
  return graph
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireText(raw: unknown, key: string, minimum: number) {
  if (typeof raw !== "string") throw new ToolError(`"${key}" must be a string`)
  const text = raw.trim()
  if (text.length < minimum || text.length > MAX_QUERY_CHARS) {
    throw new ToolError(`"${key}" must contain between ${minimum} and ${MAX_QUERY_CHARS} characters`)
  }
  return text
}

function parseLimit(raw: unknown) {
  const limit = raw ?? DEFAULT_RESULTS
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return limit
}

function matchesID(object: JsonObject, query: string) {
  const normalized = query.toLowerCase()
  const iri = iriOf(object)
  return (
    iri?.toLowerCase() === normalized ||
    fragmentOf(iri)?.toLowerCase() === normalized ||
    d3fendID(object)?.toLowerCase() === normalized
  )
}

function searchableText(object: JsonObject) {
  return [
    iriOf(object),
    d3fendID(object),
    ...fieldValues(object, [
      "label",
      "prefLabel",
      "title",
      "definition",
      "comment",
      "description",
      "altLabel",
      "alternativeLabel",
      "synonym",
    ]),
    ...scalarStrings(object["@type"]),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
}

export const D3fend: Integration = {
  id: "d3fend",
  category: "data",
  description: "Look up and search the versioned MITRE D3FEND defensive-technique ontology",
  tools: [
    {
      name: "d3fend_lookup",
      description: "Look up a MITRE D3FEND ontology entity by D3FEND id, JSON-LD IRI, or IRI fragment.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: 'D3FEND id (for example "D3-AM"), IRI, or IRI fragment' },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id"])
        const id = requireText(args.id, "id", 1)
        const match = (await loadOntology(ctx)).find((object) => matchesID(object, id))
        if (!match) throw new ToolError(`MITRE D3FEND ${VERSION} entity "${id}" was not found; check the id`)
        return { source: SOURCE, version: VERSION, entity: summarize(match) }
      },
    },
    {
      name: "d3fend_search",
      description: "Search MITRE D3FEND ontology entities by id, name, definition, alternate label, or type.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: `Search text (2-${MAX_QUERY_CHARS} characters)` },
          limit: { type: "number", description: `Maximum results (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})` },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["query", "limit"])
        const query = requireText(args.query, "query", 2)
        const limit = parseLimit(args.limit)
        const needle = query.toLowerCase()
        const matches = (await loadOntology(ctx))
          .filter((object) => searchableText(object).toLowerCase().includes(needle))
          .sort((left, right) => {
            const leftName = fieldValues(left, ["label", "prefLabel", "title"])[0] ?? ""
            const rightName = fieldValues(right, ["label", "prefLabel", "title"])[0] ?? ""
            return leftName.localeCompare(rightName)
          })
        return {
          source: SOURCE,
          version: VERSION,
          query,
          total: matches.length,
          returned: Math.min(matches.length, limit),
          results: matches.slice(0, limit).map(summarize),
        }
      },
    },
  ],
}
