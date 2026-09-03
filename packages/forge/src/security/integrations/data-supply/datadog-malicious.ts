import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const ENDPOINT = "https://raw.githubusercontent.com"
const PATH_PREFIX = "/DataDog/malicious-software-packages-dataset/main/samples/"
const CACHE_TTL_MS = 6 * 3_600_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_NAME_LENGTH = 512
const MAX_VERSIONS = 100
const MAX_VERSION_LENGTH = 200
const ATTRIBUTION = "DataDog malicious-software-packages-dataset (Apache-2.0)"
const NOTE = "Human-triaged threat context only; this result does not automatically execute or block the artifact."

const manifestPaths = {
  "ai-skill": "ai-skills/manifest.json",
  "ide-extension": "ide_extensions/manifest.json",
} as const

type Category = keyof typeof manifestPaths
type Manifest = Record<string, null | string[]>

function validateKeys(args: Record<string, unknown>) {
  const unexpected = Object.keys(args).filter((key) => !["category", "name"].includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireCategory(value: unknown): Category {
  if (value !== "ai-skill" && value !== "ide-extension") {
    throw new ToolError('"category" must be either "ai-skill" or "ide-extension"')
  }
  return value
}

function requireName(value: unknown) {
  if (typeof value !== "string" || value === "") {
    throw new ToolError('"name" must be a non-empty exact package or artifact name')
  }
  if (value !== value.trim()) {
    throw new ToolError('"name" must be exact and cannot have leading or trailing whitespace')
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new ToolError(`"name" must be at most ${MAX_NAME_LENGTH} characters`)
  }
  return value
}

export function validateManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("DataDog malicious package manifest had an unexpected shape; retry later")
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throw new ToolError("DataDog malicious package manifest was empty; retry later")
  }
  if (
    !entries.every(
      ([, scope]) => scope === null || (Array.isArray(scope) && scope.every((item) => typeof item === "string")),
    )
  ) {
    throw new ToolError("DataDog malicious package manifest had invalid version data; retry later")
  }
  return value as Manifest
}

async function loadManifest(ctx: IntegrationContext, category: Category) {
  const path = manifestPaths[category]
  try {
    return validateManifest(
      await fetchJson(`${ENDPOINT}${PATH_PREFIX}${path}`, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS, key: `datadog-malicious-${category}` },
        fixedEndpoint: { id: "datadog-malicious", endpoint: ENDPOINT, pathPrefix: PATH_PREFIX },
        maxResponseBytes: MAX_RESPONSE_BYTES,
      }),
    )
  } catch (error) {
    if (error instanceof ToolError) throw error
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(
      `failed to download the DataDog malicious package manifest${status}; check network access and retry later`,
    )
  }
}

function boundedScope(scope: null | string[]) {
  if (scope === null) return { scope: "all versions" as const }
  const versions = scope
    .slice(0, MAX_VERSIONS)
    .map((version) => (version.length > MAX_VERSION_LENGTH ? `${version.slice(0, MAX_VERSION_LENGTH - 1)}…` : version))
  const truncated = scope.length > MAX_VERSIONS || scope.some((version) => version.length > MAX_VERSION_LENGTH)
  return {
    scope: versions,
    versionsTotal: scope.length,
    ...(truncated ? { scopeTruncated: true } : {}),
  }
}

export const DatadogMalicious: Integration = {
  id: "datadog-malicious",
  category: "data",
  description: "Check exact AI skill and IDE extension names against DataDog's human-triaged malicious package dataset",
  tools: [
    {
      name: "datadog_malicious_artifact_lookup",
      description:
        "Check an exact package or artifact name in DataDog's human-triaged malicious software dataset. This only reads a manifest and never downloads package archives.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["ai-skill", "ide-extension"],
            description: "Artifact category",
          },
          name: {
            type: "string",
            description: "Exact, case-sensitive package or artifact name",
          },
        },
        required: ["category", "name"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        validateKeys(args)
        const category = requireCategory(args.category)
        const name = requireName(args.name)
        const manifest = await loadManifest(ctx, category)
        if (Object.prototype.hasOwnProperty.call(manifest, name)) {
          return {
            source: ATTRIBUTION,
            category,
            name,
            listed: true,
            ...boundedScope(manifest[name] ?? null),
            note: NOTE,
          }
        }
        const suggestion = Object.keys(manifest).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
        return {
          source: ATTRIBUTION,
          category,
          name,
          listed: false,
          scope: null,
          ...(suggestion ? { suggestion } : {}),
          note: NOTE,
        }
      },
    },
  ],
}
