import type { ExtensionItem, ExtensionManifest } from "@turenlabs/sdk/v2/client"
import { Extension } from "@turenlabs/schema"
import semver from "semver"

export type CatalogExtensionItem = ExtensionItem & {
  readonly updateAvailable?: boolean
  readonly preview?: {
    readonly label: string
    readonly detail: string
  }
}

type CatalogFetch = (input: URL, init: RequestInit) => Promise<Response>
type CatalogTrace = (phase: string, fields: Record<string, unknown>) => void

function traceUrl(input: URL) {
  const url = new URL(input)
  url.username = ""
  url.password = ""
  if (url.search) url.search = "?redacted"
  url.hash = ""
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isContribution(value: unknown) {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.secrets)
  ) {
    return false
  }
  if (value.type === "skill") return isSkillContribution(value)
  if (value.type !== "mcp") return value.type === "tool" || value.type === "data"
  return isMcpContribution(value)
}

function isSkillContribution(value: Record<string, unknown>) {
  const source = value.source
  const agent = value.agent
  return (
    isRecord(source) &&
    typeof source.type === "string" &&
    Array.isArray(value.requires) &&
    (agent === undefined || (isRecord(agent) && typeof agent.profile === "string"))
  )
}

function isMcpContribution(value: Record<string, unknown>) {
  const deployment = value.deployment
  const tools = value.tools
  return (
    isRecord(deployment) &&
    typeof deployment.type === "string" &&
    typeof value.authentication === "string" &&
    isRecord(tools) &&
    Array.isArray(tools.allow) &&
    Array.isArray(tools.write)
  )
}

function isManifest(value: unknown): value is ExtensionManifest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.version === "string" &&
    typeof value.publisher === "string" &&
    typeof value.trust === "string" &&
    Array.isArray(value.contributions) &&
    value.contributions.every(isContribution)
  )
}

function isRegistry(value: unknown): value is { extensions: unknown[] } {
  return isRecord(value) && Array.isArray(value.extensions)
}

function isCatalogPage(value: unknown): value is { items: unknown[]; nextCursor?: string } {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    (value.nextCursor === undefined || typeof value.nextCursor === "string")
  )
}

function endpointPath(endpoint: string) {
  const url = new URL(endpoint)
  const pathname = url.pathname.replace(/\/+$/, "")
  return { url, pathname, registry: pathname.toLowerCase().endsWith(".json") }
}

function registryUrl(endpoint: string) {
  const { url, pathname, registry } = endpointPath(endpoint)
  if (registry) {
    url.pathname = pathname
    return url
  }
  url.pathname = `${pathname}/registry.json`
  url.search = ""
  url.hash = ""
  return url
}

function apiUrl(endpoint: string) {
  const { url, pathname, registry } = endpointPath(endpoint)
  const base = registry ? pathname.slice(0, pathname.lastIndexOf("/")) : pathname
  url.pathname = `${base}/v1/extensions`
  url.search = ""
  url.hash = ""
  return url
}

async function loadCatalogApi(endpoint: string, signal: AbortSignal, fetcher: CatalogFetch, trace?: CatalogTrace) {
  const manifests: ExtensionManifest[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const url = apiUrl(endpoint)
    url.searchParams.set("limit", "100")
    if (cursor) url.searchParams.set("cursor", cursor)
    trace?.("catalog.api.requested", { url: traceUrl(url), cursor: cursor ?? null })
    const response = await fetcher(url, { signal, headers: { Accept: "application/json" } })
    trace?.("catalog.api.responded", { status: response.status, cursor: cursor ?? null })
    if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`)
    const data: unknown = await response.json()
    if (!isCatalogPage(data)) throw new Error("Catalog response has an invalid manifest shape")
    const items = data.items.filter(isManifest)
    manifests.push(...items)
    trace?.("catalog.api.page.loaded", {
      itemCount: items.length,
      skippedItemCount: data.items.length - items.length,
      totalItemCount: manifests.length,
    })
    if (data.nextCursor && cursors.has(data.nextCursor))
      throw new Error("Catalog response repeated a pagination cursor")
    if (data.nextCursor) cursors.add(data.nextCursor)
    cursor = data.nextCursor
  } while (cursor)
  return manifests
}

export async function loadExternalCatalog(
  endpoint: string,
  signal: AbortSignal,
  fetcher: CatalogFetch = globalThis.fetch,
  trace?: CatalogTrace,
) {
  const url = registryUrl(endpoint)
  trace?.("catalog.registry.requested", { url: traceUrl(url) })
  const response = await fetcher(url, { signal, headers: { Accept: "application/json" } })
  trace?.("catalog.registry.responded", { status: response.status })
  if (response.status === 403 || response.status === 404) {
    signal.throwIfAborted()
    trace?.("catalog.registry.fallback", { status: response.status })
    return loadCatalogApi(endpoint, signal, fetcher, trace)
  }
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!isRegistry(data)) throw new Error("Catalog registry has an invalid manifest shape")
  const manifests = data.extensions.filter(isManifest)
  trace?.("catalog.registry.loaded", {
    itemCount: manifests.length,
    skippedItemCount: data.extensions.length - manifests.length,
  })
  return manifests
}

export function catalogHomepage(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

export function mergeExternalCatalog(current: ExtensionItem[], manifests: ExtensionManifest[]): CatalogExtensionItem[] {
  const runtime = new Map(current.map((item) => [item.manifest.id, item]))
  const external = manifests.map((manifest) => {
    const existing = runtime.get(manifest.id)
    if (existing) {
      if (
        existing.installed !== true ||
        !semver.valid(existing.manifest.version) ||
        !semver.valid(manifest.version) ||
        !semver.gt(manifest.version, existing.manifest.version)
      ) {
        return existing
      }
      const normalized = Extension.normalizeExternalManifest(manifest) as unknown as ExtensionManifest | undefined
      return normalized ? { ...existing, manifest: normalized, updateAvailable: true } : existing
    }
    const normalized = Extension.normalizeExternalManifest(manifest) as unknown as ExtensionManifest | undefined
    const preview = normalized ? undefined : catalogPreview(manifest)
    return {
      manifest: normalized ?? manifest,
      origin: "catalog" as const,
      mutable: normalized !== undefined,
      enabled: false,
      status: "available" as const,
      installed: false,
      detail: normalized ? installationDetail(normalized) : undefined,
      ...(preview ? { preview } : {}),
      secretsSet: {},
      configurationSet: {},
    }
  })
  const externalIDs = new Set(manifests.map((manifest) => manifest.id))
  return [...external, ...current.filter((item) => !externalIDs.has(item.manifest.id))] as CatalogExtensionItem[]
}

function installationDetail(manifest: ExtensionManifest) {
  if (manifest.contributions.some((contribution) => contribution.type === "skill")) {
    return "Ready to install as prompt-only catalog content."
  }
  return "Ready to install as a read-only hosted MCP."
}

function catalogPreview(manifest: ExtensionManifest): CatalogExtensionItem["preview"] {
  if (
    manifest.contributions.length === 0 ||
    manifest.contributions.some((contribution) => contribution.type !== "mcp")
  ) {
    return {
      label: "TurenOS component required",
      detail: "This catalog entry needs packaged code from a TurenOS update before it can be enabled.",
    }
  }
  if (
    manifest.contributions.some(
      (contribution) => contribution.type === "mcp" && contribution.deployment.type === "local",
    )
  ) {
    return {
      label: "Local runtime required",
      detail: "Local MCP processes require an audited TurenOS adapter. Use the vendor documentation for manual setup.",
    }
  }
  return {
    label: "Reviewed adapter required",
    detail: "This MCP uses credentials or deployment controls that require an audited TurenOS adapter.",
  }
}
