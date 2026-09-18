import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../registry"
import { ToolError, type IntegrationContext } from "../types"
import { HttpError, fetchJson } from "../util/http"

/**
 * deps.dev — Google Open Source Insights (package metadata, dependencies,
 * OpenSSF Scorecard, licenses). API: https://docs.deps.dev/api/v3/ (no key,
 * caching expressly permitted; 429s are retried with backoff by util/http).
 *
 * Per-query API: responses are cached ~1h on disk (ctx.cacheDir).
 */

const API_BASE = ExtensionCatalog.dataEndpoint("security:depsdev")
const QUERY_TTL_MS = 3_600_000
const SYSTEMS = ["npm", "pypi", "go", "maven", "cargo", "nuget"] as const
const MAX_LINKS = 10
const MAX_DIRECT_DEPS = 50
const MAX_ADVISORY_LOOKUPS = 40
const ADVISORY_CONCURRENCY = 6

interface VersionKey {
  system?: string
  name?: string
  version?: string
}

interface PackageResponse {
  versions?: { versionKey?: VersionKey; publishedAt?: string; isDefault?: boolean }[]
}

interface VersionResponse {
  publishedAt?: string
  isDefault?: boolean
  licenses?: string[]
  advisoryKeys?: { id?: string }[]
  links?: { label?: string; url?: string }[]
  relatedProjects?: { projectKey?: { id?: string }; relationType?: string }[]
}

interface ProjectResponse {
  projectKey?: { id?: string }
  starsCount?: number
  forksCount?: number
  openIssuesCount?: number
  license?: string
  scorecard?: {
    date?: string
    overallScore?: number
    checks?: { name?: string; score?: number }[]
  }
}

interface DependenciesResponse {
  nodes?: { versionKey?: VersionKey; bundled?: boolean; relation?: string; errors?: string[] }[]
  edges?: { fromNode?: number; toNode?: number; requirement?: string }[]
  error?: string
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`"${key}" must be a non-empty string`)
  }
  return value.trim()
}

function parseSystem(args: Record<string, unknown>): string {
  const system = requireString(args, "system").toLowerCase()
  if (!(SYSTEMS as readonly string[]).includes(system)) {
    throw new ToolError(`unsupported system "${system}"; use one of: ${SYSTEMS.join(", ")}`)
  }
  return system
}

async function api<T>(ctx: IntegrationContext, path: string, notFoundHint: string): Promise<T> {
  try {
    return await fetchJson<T>(`${API_BASE}/${path}`, {
      cache: { dir: ctx.cacheDir, ttlMs: QUERY_TTL_MS },
    })
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new ToolError(notFoundHint)
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`deps.dev API request failed${status}; check network access and retry later`)
  }
}

function versionPath(system: string, name: string, version: string, suffix = ""): string {
  return `systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}${suffix}`
}

/** Resolve the registry's default version when the caller did not pass one. */
async function resolveVersion(ctx: IntegrationContext, system: string, name: string, args: Record<string, unknown>) {
  if (args.version !== undefined) return requireString(args, "version")
  const pkg = await api<PackageResponse>(
    ctx,
    `systems/${system}/packages/${encodeURIComponent(name)}`,
    `package "${name}" not found on deps.dev for system "${system}"; check the name and system`,
  )
  const fallback = pkg.versions?.find((entry) => entry.isDefault)?.versionKey?.version
  if (!fallback) {
    throw new ToolError(`no default version known for "${name}" (${system}); pass an explicit "version"`)
  }
  return fallback
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const systemAndPackageProps = {
  system: { type: "string", description: `Package system: ${SYSTEMS.join(", ")}` },
  package: { type: "string", description: 'Package name, e.g. "lodash" or "@scope/name"' },
  version: { type: "string", description: "Exact version (optional; defaults to the registry default version)" },
}

export const DepsDev: Integration = {
  id: "depsdev",
  category: "data",
  description: "Query deps.dev for package health (licenses, advisories, OpenSSF Scorecard) and dependency graphs",
  tools: [
    {
      name: "depsdev_package_health",
      description:
        "Get deps.dev health insights for a package version: licenses, known advisory keys, OpenSSF Scorecard summary, and project links.",
      inputSchema: {
        type: "object",
        properties: systemAndPackageProps,
        required: ["system", "package"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const system = parseSystem(args)
        const name = requireString(args, "package")
        const version = await resolveVersion(ctx, system, name, args)
        const detail = await api<VersionResponse>(
          ctx,
          versionPath(system, name, version),
          `version "${version}" of "${name}" not found on deps.dev for system "${system}"; check name and version`,
        )

        const related = detail.relatedProjects ?? []
        const projectId = (related.find((entry) => entry.relationType === "SOURCE_REPO") ?? related[0])?.projectKey?.id
        // Scorecard is best-effort: not every package maps to a scanned project.
        let project: ProjectResponse | undefined
        if (projectId) {
          project = await api<ProjectResponse>(ctx, `projects/${encodeURIComponent(projectId)}`, "").catch(
            () => undefined,
          )
        }

        return {
          source: "depsdev",
          system,
          package: name,
          version,
          isDefault: detail.isDefault,
          publishedAt: detail.publishedAt,
          licenses: detail.licenses ?? [],
          advisories: (detail.advisoryKeys ?? []).flatMap((key) => (key.id ? [key.id] : [])),
          links: (detail.links ?? []).slice(0, MAX_LINKS).map((link) => ({ label: link.label, url: link.url })),
          project: project
            ? {
                id: project.projectKey?.id,
                stars: project.starsCount,
                forks: project.forksCount,
                openIssues: project.openIssuesCount,
                license: project.license,
              }
            : undefined,
          scorecard: project?.scorecard
            ? {
                date: project.scorecard.date,
                overallScore: project.scorecard.overallScore,
                checks: (project.scorecard.checks ?? []).map((check) => ({ name: check.name, score: check.score })),
              }
            : undefined,
        }
      },
    },
    {
      name: "depsdev_package_dependencies",
      description:
        "Get the resolved dependency graph for a package version from deps.dev, trimmed to direct dependencies plus counts; direct dependencies with known advisories are flagged.",
      inputSchema: {
        type: "object",
        properties: systemAndPackageProps,
        required: ["system", "package"],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const system = parseSystem(args)
        const name = requireString(args, "package")
        const version = await resolveVersion(ctx, system, name, args)
        const graph = await api<DependenciesResponse>(
          ctx,
          versionPath(system, name, version, ":dependencies"),
          `version "${version}" of "${name}" not found on deps.dev for system "${system}"; check name and version`,
        )

        const nodes = graph.nodes ?? []
        const selfIndex = nodes.findIndex((node) => node.relation === "SELF")
        const requirementByTarget = new Map<number, string>()
        for (const edge of graph.edges ?? []) {
          if (edge.fromNode === selfIndex && typeof edge.toNode === "number" && edge.requirement !== undefined) {
            requirementByTarget.set(edge.toNode, edge.requirement)
          }
        }

        const direct = nodes.map((node, index) => ({ node, index })).filter((entry) => entry.node.relation === "DIRECT")
        const indirectCount = nodes.filter((node) => node.relation === "INDIRECT").length
        const withErrors = nodes.filter((node) => (node.errors?.length ?? 0) > 0).length

        // Advisory info is not part of the graph response; look up each direct
        // dependency's version record (bounded + cached ~1h) to flag advisories.
        const toCheck = direct.slice(0, MAX_ADVISORY_LOOKUPS)
        const advisoriesByIndex = new Map<number, string[]>()
        await mapLimit(toCheck, ADVISORY_CONCURRENCY, async (entry) => {
          const key = entry.node.versionKey
          if (!key?.system || !key.name || !key.version) return
          const detail = await api<VersionResponse>(
            ctx,
            versionPath(key.system.toLowerCase(), key.name, key.version),
            "",
          ).catch(() => undefined)
          const ids = (detail?.advisoryKeys ?? []).flatMap((advisory) => (advisory.id ? [advisory.id] : []))
          if (ids.length > 0) advisoriesByIndex.set(entry.index, ids)
        })

        const directDeps = direct.slice(0, MAX_DIRECT_DEPS).map((entry) => {
          const advisories = advisoriesByIndex.get(entry.index)
          return {
            name: entry.node.versionKey?.name,
            version: entry.node.versionKey?.version,
            requirement: requirementByTarget.get(entry.index),
            bundled: entry.node.bundled === true ? true : undefined,
            ...(advisories ? { advisories } : {}),
          }
        })

        return {
          source: "depsdev",
          system,
          package: name,
          version,
          counts: {
            total: Math.max(nodes.length - (selfIndex >= 0 ? 1 : 0), 0),
            direct: direct.length,
            indirect: indirectCount,
            withResolutionErrors: withErrors,
          },
          directDependencies: directDeps,
          directDependenciesTruncated: direct.length > MAX_DIRECT_DEPS ? true : undefined,
          advisoryCheck:
            direct.length > MAX_ADVISORY_LOOKUPS
              ? `direct dependencies only (first ${MAX_ADVISORY_LOOKUPS} of ${direct.length} checked)`
              : "direct dependencies only",
          graphError: graph.error || undefined,
        }
      },
    },
  ],
}
