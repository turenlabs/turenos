import { ExtensionCatalog } from "@turenlabs/extensions"
import type { Integration } from "../../registry"
import { ToolError, type IntegrationContext } from "../../types"
import { fetchJson, HttpError } from "../../util/http"

const API = ExtensionCatalog.dataEndpoint("security:scorecard")
const CACHE_TTL_MS = 3_600_000
const MAX_CHECKS = 20
const ATTRIBUTION = "OpenSSF Scorecard (CDLA-Permissive-2.0)"
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/

type JsonObject = Record<string, unknown>

function validateKeys(args: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new ToolError(`unexpected argument(s): ${unexpected.join(", ")}`)
}

function requireComponent(value: unknown, kind: "owner" | "repository") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(`GitHub ${kind} must be a non-empty string`)
  }
  const component = value.trim()
  if (
    component.includes("/") ||
    component.includes("\\") ||
    component.includes("%") ||
    component === "." ||
    component === ".."
  ) {
    throw new ToolError(`invalid GitHub ${kind} "${value}"; path separators, encoding, and traversal are forbidden`)
  }
  if (kind === "owner" && !OWNER.test(component)) {
    throw new ToolError(`invalid GitHub owner "${value}"; use 1-39 letters, digits, or non-edge hyphens`)
  }
  if (kind === "repository" && !REPOSITORY.test(component)) {
    throw new ToolError(
      `invalid GitHub repository "${value}"; use 1-100 letters, digits, dots, underscores, or hyphens`,
    )
  }
  return component
}

function githubProject(args: Record<string, unknown>) {
  validateKeys(args, ["repository", "owner", "repo"])
  if (args.repository !== undefined) {
    if (args.owner !== undefined || args.repo !== undefined) {
      throw new ToolError('pass either "repository" as "owner/repo" or separate "owner" and "repo", not both')
    }
    if (typeof args.repository !== "string") throw new ToolError('"repository" must use the form "owner/repo"')
    const parts = args.repository.trim().split("/")
    if (parts.length !== 2) {
      throw new ToolError('"repository" must use exactly the form "owner/repo" with no extra path')
    }
    return { owner: requireComponent(parts[0], "owner"), repo: requireComponent(parts[1], "repository") }
  }
  if (args.owner === undefined || args.repo === undefined) {
    throw new ToolError('provide "repository" as "owner/repo", or provide both "owner" and "repo"')
  }
  return { owner: requireComponent(args.owner, "owner"), repo: requireComponent(args.repo, "repository") }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function text(record: JsonObject, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "string")
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function numeric(record: JsonObject, ...keys: string[]): number | undefined {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "number")
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function checks(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const check = object(entry)
    const name = check ? text(check, "name") : undefined
    if (!check || !name) return []
    const score = numeric(check, "score")
    const reason = text(check, "reason")
    const documentation = object(check.documentation)
    const documentationUrl = documentation ? text(documentation, "url") : undefined
    return [
      {
        name,
        ...(score !== undefined ? { score } : {}),
        ...(reason ? { reason: clip(reason, 240) } : {}),
        ...(documentationUrl ? { documentation: documentationUrl } : {}),
      },
    ]
  })
}

async function lookup(ctx: IntegrationContext, owner: string, repo: string) {
  const url = `${API}/projects/github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  try {
    const response = object(
      await fetchJson(url, {
        cache: { dir: ctx.cacheDir, ttlMs: CACHE_TTL_MS },
        fixedEndpoint: { id: "scorecard", endpoint: API, pathPrefix: "/projects/github.com/" },
        maxResponseBytes: 2 * 1024 * 1024,
      }),
    )
    if (!response) throw new ToolError("OpenSSF Scorecard returned an unexpected response; retry later")
    return response
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (error instanceof HttpError && error.status === 404) {
      throw new ToolError(
        `OpenSSF Scorecard has no result for github.com/${owner}/${repo}; check the repository or try again after it is scanned`,
      )
    }
    const status = error instanceof HttpError ? ` (HTTP ${error.status})` : ""
    throw new ToolError(`OpenSSF Scorecard request failed${status}; check network access and retry later`)
  }
}

export const Scorecard: Integration = {
  id: "scorecard",
  category: "data",
  description: "Fetch OpenSSF Scorecard supply-chain security results for GitHub repositories",
  tools: [
    {
      name: "scorecard_lookup",
      description: "Get a compact OpenSSF Scorecard score and check summary for a GitHub owner/repository.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: 'GitHub repository in "owner/repo" form' },
          owner: { type: "string", description: "GitHub owner (alternative to repository)" },
          repo: { type: "string", description: "GitHub repository name (requires owner)" },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const project = githubProject(args)
        const response = await lookup(ctx, project.owner, project.repo)
        const repo = object(response.repo)
        const score = numeric(response, "score")
        const date = text(response, "date")
        const commit = repo ? text(repo, "commit") : undefined
        const resultChecks = checks(response.checks)
          .sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY))
          .slice(0, MAX_CHECKS)
        return {
          source: ATTRIBUTION,
          repository: `github.com/${project.owner}/${project.repo}`,
          ...(score !== undefined ? { score } : {}),
          ...(date ? { date } : {}),
          ...(commit ? { commit: clip(commit, 80) } : {}),
          checks: resultChecks,
          checksTotal: Array.isArray(response.checks) ? response.checks.length : resultChecks.length,
          ...(Array.isArray(response.checks) && response.checks.length > MAX_CHECKS ? { checksTruncated: true } : {}),
          sourceUrl: `https://scorecard.dev/viewer/?uri=github.com/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}`,
        }
      },
    },
  ],
}
