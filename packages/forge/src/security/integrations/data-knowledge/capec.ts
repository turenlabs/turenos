import { DomUtils, parseDocument } from "htmlparser2"
import { XMLValidator } from "fast-xml-parser"
import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchText, HttpError } from "../../util/http"

const FEED_URL = ExtensionCatalog.dataEndpoint("security:capec", "feed")
const FIXED_ENDPOINT = { id: "capec", endpoint: FEED_URL, pathPrefix: "/data/xml/" }
const CACHE_TTL_MS = 24 * 3_600_000
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024
const MAX_QUERY_CHARS = 120
const MAX_RESULTS = 10
const SOURCE = "MITRE CAPEC"
const ATTRIBUTION =
  "Copyright © 2007–2026, The MITRE Corporation. CAPEC and the CAPEC logo are trademarks of The MITRE Corporation."
const LICENSE =
  "The MITRE Corporation (MITRE) hereby grants you a non-exclusive, royalty-free license to use Common Attack Pattern Enumeration and Classification (CAPEC™) for research, development, and commercial purposes. Any copy you make for such purposes is authorized provided that you reproduce MITRE’s copyright designation and this license in any such copy."
const DISCLAIMER =
  'ALL DOCUMENTS AND THE INFORMATION CONTAINED THEREIN ARE PROVIDED ON AN "AS IS" BASIS AND THE CONTRIBUTOR, THE ORGANIZATION HE/SHE REPRESENTS OR IS SPONSORED BY (IF ANY), THE MITRE CORPORATION, ITS BOARD OF TRUSTEES, OFFICERS, AGENTS, AND EMPLOYEES, DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION THEREIN WILL NOT INFRINGE ANY RIGHTS OR ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.'
const SOURCE_METADATA = { source: SOURCE, attribution: ATTRIBUTION, license: LICENSE, disclaimer: DISCLAIMER }

interface Pattern {
  id: number
  name: string
  abstraction?: string
  status?: string
  description?: string
  extendedDescription?: string
  likelihood?: string
  typicalSeverity?: string
  prerequisites: string[]
  mitigations: string[]
  weaknessIDs: number[]
  relatedPatternIDs: number[]
}

type XmlElement = ReturnType<typeof DomUtils.getElementsByTagName>[number]

function clip(value: string, max: number) {
  const compact = value.replaceAll(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function children(element: XmlElement, name: string) {
  return DomUtils.getElementsByTagName(name, element.children, false)
}

function childText(element: XmlElement, name: string, max: number) {
  const value = children(element, name)[0]
  if (!value) return undefined
  return clip(DomUtils.textContent(value), max) || undefined
}

function childList(element: XmlElement, containerName: string, itemName: string, max: number) {
  const container = children(element, containerName)[0]
  if (!container) return []
  return children(container, itemName)
    .map((item) => clip(DomUtils.textContent(item), max))
    .filter(Boolean)
    .slice(0, 8)
}

function childIDs(element: XmlElement, containerName: string, itemName: string, attribute: string) {
  const container = children(element, containerName)[0]
  if (!container) return []
  return children(container, itemName).flatMap((item) => {
    const raw = item.attribs[attribute]
    return raw && /^\d{1,5}$/.test(raw) && Number(raw) > 0 ? [Number(raw)] : []
  })
}

function parseCatalog(xml: string) {
  if (XMLValidator.validate(xml) !== true) {
    throw new ToolError("MITRE CAPEC returned an invalid XML catalog; check network access and retry later")
  }
  const document = parseDocument(xml, { xmlMode: true, decodeEntities: true })
  const roots = DomUtils.getElementsByTagName("Attack_Pattern_Catalog", document.children, false)
  const root = roots[0]
  const documentElements = document.children.filter((child) => child.type === "tag")
  const version = root?.attribs.Version ?? ""
  const date = root?.attribs.Date ?? ""
  const container = root && children(root, "Attack_Patterns")[0]
  const records = container ? children(container, "Attack_Pattern") : []
  const patterns = records.flatMap((record): Pattern[] => {
    const id = Number(record.attribs.ID)
    const name = record.attribs.Name?.trim()
    if (!Number.isInteger(id) || id < 1 || id > 99_999 || !name) return []
    const description = childText(record, "Description", 4_000)
    const extendedDescription = childText(record, "Extended_Description", 4_000)
    const likelihood = childText(record, "Likelihood_Of_Attack", 40)
    const typicalSeverity = childText(record, "Typical_Severity", 40)
    return [
      {
        id,
        name,
        ...(record.attribs.Abstraction ? { abstraction: record.attribs.Abstraction } : {}),
        ...(record.attribs.Status ? { status: record.attribs.Status } : {}),
        ...(description ? { description } : {}),
        ...(extendedDescription ? { extendedDescription } : {}),
        ...(likelihood ? { likelihood } : {}),
        ...(typicalSeverity ? { typicalSeverity } : {}),
        prerequisites: childList(record, "Prerequisites", "Prerequisite", 1_000),
        mitigations: childList(record, "Mitigations", "Mitigation", 1_000),
        weaknessIDs: childIDs(record, "Related_Weaknesses", "Related_Weakness", "CWE_ID"),
        relatedPatternIDs: childIDs(record, "Related_Attack_Patterns", "Related_Attack_Pattern", "CAPEC_ID"),
      },
    ]
  })
  const ids = patterns.map((pattern) => pattern.id)
  if (
    roots.length !== 1 ||
    documentElements.length !== 1 ||
    documentElements[0] !== root ||
    !/^\d+\.\d+$/.test(version) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    patterns.length === 0 ||
    patterns.length !== records.length ||
    new Set(ids).size !== ids.length
  ) {
    throw new ToolError("MITRE CAPEC returned an invalid XML catalog; check network access and retry later")
  }
  return { version, date, patterns: patterns.toSorted((left, right) => left.id - right.id) }
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireID(raw: unknown) {
  const match = typeof raw === "string" ? raw.trim().match(/^(?:CAPEC-)?([1-9]\d{0,4})$/i) : undefined
  if (!match) throw new ToolError('"id" must be a CAPEC id such as "CAPEC-66"')
  return Number(match[1])
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

async function loadCatalog(ctx: IntegrationContext) {
  let xml: string
  try {
    xml = await fetchText(FEED_URL, {
      fixedEndpoint: FIXED_ENDPOINT,
      cache: {
        dir: ctx.cacheDir,
        ttlMs: CACHE_TTL_MS,
        key: "capec-latest-xml",
        validate: (value) => {
          if (typeof value !== "string") throw new ToolError("MITRE CAPEC returned an invalid XML catalog")
          parseCatalog(value)
        },
      },
      maxResponseBytes: MAX_RESPONSE_BYTES,
    })
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download MITRE CAPEC${status}; check network access and retry later`)
  }
  return parseCatalog(xml)
}

function searchResult(pattern: Pattern) {
  return {
    id: `CAPEC-${pattern.id}`,
    name: clip(pattern.name, 240),
    ...(pattern.abstraction ? { abstraction: clip(pattern.abstraction, 40) } : {}),
    ...(pattern.status ? { status: clip(pattern.status, 40) } : {}),
    ...(pattern.description ? { description: clip(pattern.description, 500) } : {}),
    ...(pattern.weaknessIDs.length
      ? { relatedWeaknesses: [...new Set(pattern.weaknessIDs)].slice(0, 8).map((id) => `CWE-${id}`) }
      : {}),
    url: `https://capec.mitre.org/data/definitions/${pattern.id}`,
  }
}

function detail(pattern: Pattern, version: string, date: string) {
  return {
    ...SOURCE_METADATA,
    version,
    date,
    pattern: {
      ...searchResult(pattern),
      ...(pattern.extendedDescription ? { extendedDescription: clip(pattern.extendedDescription, 800) } : {}),
      ...(pattern.likelihood ? { likelihood: clip(pattern.likelihood, 40) } : {}),
      ...(pattern.typicalSeverity ? { typicalSeverity: clip(pattern.typicalSeverity, 40) } : {}),
      ...(pattern.prerequisites.length
        ? { prerequisites: pattern.prerequisites.slice(0, 5).map((value) => clip(value, 240)) }
        : {}),
      ...(pattern.mitigations.length
        ? { mitigations: pattern.mitigations.slice(0, 5).map((value) => clip(value, 240)) }
        : {}),
      ...(pattern.relatedPatternIDs.length
        ? { relatedAttackPatterns: [...new Set(pattern.relatedPatternIDs)].slice(0, 8).map((id) => `CAPEC-${id}`) }
        : {}),
    },
  }
}

export const Capec: Integration = {
  id: "capec",
  category: "data",
  description: "Look up and search MITRE CAPEC application attack patterns and their CWE relationships",
  tools: [
    {
      name: "capec_lookup",
      description: "Look up a MITRE CAPEC attack pattern by id, including defensive mitigations and related CWEs.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^(CAPEC-)?[1-9][0-9]{0,4}$", description: 'CAPEC id, for example "CAPEC-66"' },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id"])
        const id = requireID(args.id)
        const catalog = await loadCatalog(ctx)
        const pattern = catalog.patterns.find((entry) => entry.id === id)
        if (!pattern) throw new ToolError(`MITRE CAPEC-${id} was not found; check the id`)
        return detail(pattern, catalog.version, catalog.date)
      },
    },
    {
      name: "capec_search",
      description: "Search MITRE CAPEC attack patterns by name, description, or related CWE id (maximum 10 results).",
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
        const catalog = await loadCatalog(ctx)
        const needle = query.toLowerCase()
        const matches = catalog.patterns.filter((pattern) =>
          [
            pattern.name,
            pattern.description,
            pattern.extendedDescription,
            ...pattern.weaknessIDs.map((id) => `CWE-${id}`),
          ]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.toLowerCase().includes(needle)),
        )
        return {
          ...SOURCE_METADATA,
          version: catalog.version,
          date: catalog.date,
          query,
          total: matches.length,
          returned: Math.min(matches.length, limit),
          results: matches.slice(0, limit).map(searchResult),
        }
      },
    },
  ],
}

export { parseCatalog }
