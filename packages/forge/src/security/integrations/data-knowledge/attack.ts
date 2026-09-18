import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

/** MITRE ATT&CK Enterprise STIX data, synchronized from MITRE's official repository. */

const BUNDLE_URL = ExtensionCatalog.dataEndpoint("security:attack")
const VERSION = BUNDLE_URL.match(/attack-stix-data\/v([\d.]+)\//)?.[1] ?? "unknown"
const FIXED_ENDPOINT = {
  id: "attack",
  endpoint: BUNDLE_URL,
  pathPrefix: new URL(BUNDLE_URL).pathname.replace(/[^/]+$/, ""),
}
const SOURCE = `MITRE ATT&CK Enterprise v${VERSION} (STIX 2.1)`
const BUNDLE_TTL_MS = 24 * 3_600_000
const MAX_QUERY_CHARS = 120
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 10
const MAX_DESCRIPTION_CHARS = 500
const ATTACK_TYPES = [
  "attack-pattern",
  "campaign",
  "course-of-action",
  "intrusion-set",
  "malware",
  "tool",
  "x-mitre-data-component",
  "x-mitre-data-source",
  "x-mitre-matrix",
  "x-mitre-tactic",
] as const

interface AttackReference {
  source_name?: string
  external_id?: string
  url?: string
}

interface AttackObject {
  id?: string
  type?: string
  name?: string
  description?: string
  modified?: string
  revoked?: boolean
  x_mitre_deprecated?: boolean
  x_mitre_domains?: string[]
  x_mitre_platforms?: string[]
  external_references?: AttackReference[]
  kill_chain_phases?: { kill_chain_name?: string; phase_name?: string }[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAttackObject(value: unknown): value is AttackObject {
  return isObject(value)
}

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  const compact = text.replaceAll(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

function clipStrings(values: readonly string[], max: number, count: number) {
  return values
    .slice(0, count)
    .map((value) => clip(value, max))
    .filter((value): value is string => value !== undefined)
}

function isActive(object: AttackObject) {
  return object.revoked !== true && object.x_mitre_deprecated !== true
}

function attackReference(object: AttackObject) {
  return object.external_references?.find(
    (reference) =>
      reference.source_name === "mitre-attack" || reference.source_name?.startsWith("mitre-attack-") === true,
  )
}

function summarize(object: AttackObject) {
  const reference = attackReference(object)
  const phases = (object.kill_chain_phases ?? [])
    .flatMap((phase) => (phase.phase_name ? [phase.phase_name] : []))
    .slice(0, 8)
  return {
    ...(reference?.external_id ? { attackId: clip(reference.external_id, 40) } : {}),
    ...(object.id ? { stixId: clip(object.id, 120) } : {}),
    ...(object.type ? { type: clip(object.type, 80) } : {}),
    ...(object.name ? { name: clip(object.name, 240) } : {}),
    ...(object.description ? { description: clip(object.description, MAX_DESCRIPTION_CHARS) } : {}),
    ...(object.x_mitre_platforms?.length ? { platforms: clipStrings(object.x_mitre_platforms, 80, 12) } : {}),
    ...(object.x_mitre_domains?.length ? { domains: clipStrings(object.x_mitre_domains, 80, 6) } : {}),
    ...(phases.length ? { killChainPhases: clipStrings(phases, 80, 8) } : {}),
    ...(object.modified ? { modified: clip(object.modified, 80) } : {}),
    ...(reference?.url ? { url: clip(reference.url, 300) } : {}),
  }
}

async function loadBundle(ctx: IntegrationContext): Promise<AttackObject[]> {
  let bundle: unknown
  try {
    bundle = await fetchJson(BUNDLE_URL, {
      fixedEndpoint: FIXED_ENDPOINT,
      cache: { dir: ctx.cacheDir, ttlMs: BUNDLE_TTL_MS, key: `enterprise-attack-${VERSION}-stix-2.1` },
      maxResponseBytes: 56 * 1024 * 1024,
    })
  } catch (error) {
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`failed to download MITRE ATT&CK Enterprise data${status}; check network access and retry`)
  }
  if (!isObject(bundle) || bundle.type !== "bundle" || !Array.isArray(bundle.objects)) {
    throw new ToolError("MITRE ATT&CK Enterprise data had an unexpected STIX bundle shape; retry later")
  }
  return bundle.objects.filter(isAttackObject).filter(isActive)
}

function requireLookupID(raw: unknown) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ToolError('"id" must be an ATT&CK id such as "T1059" or a STIX UUID')
  }
  const id = raw.trim()
  if (id.length > MAX_QUERY_CHARS) throw new ToolError(`"id" must be at most ${MAX_QUERY_CHARS} characters`)
  const attackID = /^[A-Z]{1,4}\d{3,5}(?:\.\d{3})?$/i.test(id)
  const stixID =
    /^(?:[a-z][a-z0-9-]*--)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  if (!attackID && !stixID) {
    throw new ToolError(`"${id}" is not an ATT&CK external id or STIX UUID; try a value such as "T1059"`)
  }
  return id
}

function parseLimit(raw: unknown) {
  const limit = raw ?? DEFAULT_RESULTS
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolError(`"limit" must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return limit
}

export const Attack: Integration = {
  id: "attack",
  category: "data",
  description: "Look up and search MITRE ATT&CK Enterprise techniques, groups, software, and mitigations",
  tools: [
    {
      name: "attack_lookup",
      description: "Look up an active MITRE ATT&CK Enterprise object by ATT&CK id or STIX UUID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: 'ATT&CK id (for example "T1059") or STIX UUID' },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["id"])
        const id = requireLookupID(args.id)
        const normalized = id.toLowerCase()
        const match = (await loadBundle(ctx)).find((object) => {
          if (object.id?.toLowerCase() === normalized || object.id?.split("--").at(-1)?.toLowerCase() === normalized) {
            return true
          }
          return object.external_references?.some((reference) => reference.external_id?.toLowerCase() === normalized)
        })
        if (!match) {
          throw new ToolError(`active MITRE ATT&CK Enterprise object "${id}" was not found; check the id`)
        }
        return { source: SOURCE, object: summarize(match) }
      },
    },
    {
      name: "attack_search",
      description:
        "Search active MITRE ATT&CK Enterprise objects by name, external id, or description, optionally restricted to a STIX object type.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: `Search text (2-${MAX_QUERY_CHARS} characters)` },
          type: { type: "string", enum: ATTACK_TYPES, description: "Optional STIX object type" },
          limit: { type: "number", description: `Maximum results (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})` },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args, ["query", "type", "limit"])
        if (typeof args.query !== "string") throw new ToolError('"query" must be a string')
        const query = args.query.trim()
        if (query.length < 2 || query.length > MAX_QUERY_CHARS) {
          throw new ToolError(`"query" must contain between 2 and ${MAX_QUERY_CHARS} characters`)
        }
        const type = args.type
        if (type !== undefined && (typeof type !== "string" || !(ATTACK_TYPES as readonly string[]).includes(type))) {
          throw new ToolError(`"type" must be one of: ${ATTACK_TYPES.join(", ")}`)
        }
        const limit = parseLimit(args.limit)
        const needle = query.toLowerCase()
        const matches = (await loadBundle(ctx))
          .filter((object) => type === undefined || object.type === type)
          .filter((object) => {
            const externalID = attackReference(object)?.external_id ?? ""
            return `${externalID} ${object.name ?? ""} ${object.description ?? ""}`.toLowerCase().includes(needle)
          })
          .sort((left, right) => {
            const leftID = attackReference(left)?.external_id ?? ""
            const rightID = attackReference(right)?.external_id ?? ""
            return leftID.localeCompare(rightID) || (left.name ?? "").localeCompare(right.name ?? "")
          })
        return {
          source: SOURCE,
          query,
          ...(typeof type === "string" ? { type } : {}),
          total: matches.length,
          returned: Math.min(matches.length, limit),
          results: matches.slice(0, limit).map(summarize),
        }
      },
    },
  ],
}
