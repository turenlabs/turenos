import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

/** MITRE CWE REST API. */

const API = ExtensionCatalog.dataEndpoint("security:cwe")
const FIXED_ENDPOINT = { id: "cwe", endpoint: API, pathPrefix: "/api/v1/" }
const SOURCE = "MITRE Common Weakness Enumeration (CWE)"
const QUERY_TTL_MS = 3_600_000
const MAX_DESCRIPTION_CHARS = 700
const MAX_RELATIONSHIPS = 30
const RELATIONSHIPS = ["parents", "children", "ancestors", "descendants"] as const

interface CweRelationship {
  Nature?: string
  CWEID?: string | number
  CweID?: string | number
  ViewID?: string | number
  Ordinal?: string
}

interface CweWeakness {
  ID?: string | number
  Name?: string
  Abstraction?: string
  Structure?: string
  Status?: string
  Description?: string
  ExtendedDescription?: string
  RelatedWeaknesses?: CweRelationship[]
  AlternateTerms?: { Term?: string; Description?: string }[]
}

interface CweRelationshipNode {
  Type?: string
  ID?: string | number
  ViewID?: string | number
  Primary_Parent?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireID(raw: unknown) {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw.trim())) {
    throw new ToolError('"id" must be a numeric CWE id string, for example "79"')
  }
  const id = raw.trim().replace(/^0+(?=\d)/, "")
  if (id === "0") throw new ToolError('"id" must be a positive numeric CWE id')
  return id
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const compact = text.replaceAll(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function summarizeRelationship(relationship: CweRelationship) {
  const value = relationship.CWEID ?? relationship.CweID
  const related = value === undefined ? undefined : String(value)
  return {
    ...(relationship.Nature ? { nature: clip(relationship.Nature, 80) } : {}),
    ...(related ? { id: clip(`CWE-${related}`, 80) } : {}),
    ...(relationship.ViewID !== undefined ? { viewId: clip(String(relationship.ViewID), 40) } : {}),
    ...(relationship.Ordinal ? { ordinal: clip(relationship.Ordinal, 80) } : {}),
  }
}

async function requestCwe(ctx: IntegrationContext, path: string) {
  let response: unknown
  try {
    response = await fetchJson(`${API}/${path}`, {
      fixedEndpoint: FIXED_ENDPOINT,
      cache: { dir: ctx.cacheDir, ttlMs: QUERY_TTL_MS },
    })
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new ToolError("MITRE CWE did not find that entry; check the numeric id")
    }
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`MITRE CWE API request failed${status}; check network access and retry later`)
  }
  return response
}

async function loadWeakness(ctx: IntegrationContext, id: string): Promise<CweWeakness> {
  const response = await requestCwe(ctx, `cwe/weakness/${id}`)
  const weaknesses = isObject(response) ? (response.Weaknesses ?? response.weaknesses) : undefined
  if (!Array.isArray(weaknesses)) throw new ToolError("MITRE CWE API returned an unexpected weakness shape")
  const weakness = weaknesses.filter(isObject)[0] as CweWeakness | undefined
  if (!weakness) throw new ToolError(`CWE-${id} was not found in the MITRE CWE catalog; check the numeric id`)
  return weakness
}

async function loadRelationships(ctx: IntegrationContext, id: string, relationship: string) {
  const response = await requestCwe(ctx, `cwe/${id}/${relationship}`)
  if (!Array.isArray(response)) throw new ToolError("MITRE CWE API returned an unexpected relationship shape")
  return response.filter(isObject) as CweRelationshipNode[]
}

function summarizeRelationshipNode(node: CweRelationshipNode) {
  return {
    ...(node.ID === undefined ? {} : { id: `CWE-${node.ID}` }),
    ...(node.Type ? { type: node.Type } : {}),
    ...(node.ViewID === undefined ? {} : { viewId: String(node.ViewID) }),
    ...(node.Primary_Parent === undefined ? {} : { primaryParent: node.Primary_Parent }),
  }
}

function parseRelationship(raw: unknown) {
  if (typeof raw !== "string" || !(RELATIONSHIPS as readonly string[]).includes(raw)) {
    throw new ToolError(`"relationship" must be one of: ${RELATIONSHIPS.join(", ")}`)
  }
  return raw
}

export const Cwe: Integration = {
  id: "cwe",
  category: "data",
  description: "Look up MITRE CWE weakness definitions and taxonomy relationships",
  tools: [
    {
      name: "cwe_lookup",
      description: "Look up a CWE weakness definition by its numeric MITRE CWE id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[0-9]{1,5}$", description: 'Numeric CWE id, for example "79"' },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id"])
        const id = requireID(args.id)
        const weakness = await loadWeakness(ctx, id)
        const relationships = (weakness.RelatedWeaknesses ?? []).slice(0, MAX_RELATIONSHIPS).map(summarizeRelationship)
        const alternateTerms = (weakness.AlternateTerms ?? [])
          .flatMap((term) => (term.Term ? [clip(term.Term, 240)] : []))
          .filter((term): term is string => term !== undefined)
          .slice(0, 10)
        return {
          source: SOURCE,
          id: `CWE-${id}`,
          ...(weakness.Name ? { name: clip(weakness.Name, 240) } : {}),
          ...(weakness.Abstraction ? { abstraction: clip(weakness.Abstraction, 80) } : {}),
          ...(weakness.Structure ? { structure: clip(weakness.Structure, 80) } : {}),
          ...(weakness.Status ? { status: clip(weakness.Status, 80) } : {}),
          ...(weakness.Description ? { description: clip(weakness.Description, MAX_DESCRIPTION_CHARS) } : {}),
          ...(weakness.ExtendedDescription
            ? { extendedDescription: clip(weakness.ExtendedDescription, MAX_DESCRIPTION_CHARS) }
            : {}),
          ...(alternateTerms.length ? { alternateTerms } : {}),
          ...(relationships.length ? { relationships } : {}),
          url: `https://cwe.mitre.org/data/definitions/${id}.html`,
        }
      },
    },
    {
      name: "cwe_relationships",
      description: "List MITRE CWE parents, children, ancestors, or descendants for a numeric CWE id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[0-9]{1,5}$", description: 'Numeric CWE id, for example "79"' },
          relationship: {
            type: "string",
            enum: RELATIONSHIPS,
            description: "Relationship nature to return",
          },
        },
        required: ["id", "relationship"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id", "relationship"])
        const id = requireID(args.id)
        const relationship = parseRelationship(args.relationship)
        const matches = await loadRelationships(ctx, id, relationship)
        return {
          source: SOURCE,
          id: `CWE-${id}`,
          relationship,
          total: matches.length,
          relationships: matches.slice(0, MAX_RELATIONSHIPS).map(summarizeRelationshipNode),
        }
      },
    },
  ],
}
