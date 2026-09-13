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

const CATALOG_TIMEOUT = 15_000

function endpointUrl(endpoint: string) {
  try {
    return new URL(endpoint)
  } catch (cause) {
    throw new Error(`The catalog endpoint "${endpoint}" is not a valid URL`, { cause })
  }
}

function endpointPath(endpoint: string) {
  const url = endpointUrl(endpoint)
  const pathname = url.pathname.replace(/\/+$/, "")
  return { url, pathname, registry: pathname.toLowerCase().endsWith(".json") }
}

function errorChain(cause: unknown) {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current = cause
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    parts.push(current.name, current.message)
    const code = (current as { code?: unknown }).code
    if (typeof code === "string") parts.push(code)
    current = current.cause
  }
  if (typeof current === "string") parts.push(current)
  else if (isRecord(current) && typeof current.code === "string") parts.push(current.code)
  if (parts.length === 0) parts.push(String(current))
  return parts.join(" ").toLowerCase()
}

function catalogNetworkMessage(url: URL, cause: unknown, timedOut: boolean) {
  const host = url.host
  const detail = errorChain(cause)
  if (timedOut || /timed?[\s_]?out/.test(detail))
    return `Timed out connecting to the extension catalog at ${host}. Check your internet connection and try again.`
  if (/enotfound|eai_again|name_not_resolved|name_resolution|dns/.test(detail))
    return `Could not resolve the extension catalog host "${host}". Check your internet connection or DNS settings.`
  if (/econnrefused|connection_refused/.test(detail))
    return `The extension catalog at ${host} refused the connection. It may be down or blocked by a firewall.`
  if (/econnreset|connection_reset|connection_aborted|epipe|socket/.test(detail))
    return `The connection to the extension catalog at ${host} was interrupted. Try again.`
  if (/enetunreach|ehostunreach|eaddrnotavail|internet_disconnected|network_(unreachable|changed)|address_unreachable/.test(detail))
    return `The network is unreachable while connecting to the extension catalog at ${host}. Check your internet connection.`
  if (/proxy|tunnel/.test(detail))
    return `Could not reach the extension catalog at ${host} through the configured proxy.`
  if (/cert|ssl|tls|unable_to_verify|self.?signed|certificate/.test(detail))
    return `The secure connection to the extension catalog at ${host} failed certificate verification.`
  return `Could not connect to the extension catalog at ${host}. Check your internet connection and try again.`
}

function catalogHttpMessage(status: number, url: URL) {
  if (status === 401 || status === 403)
    return `The extension catalog at ${url.host} rejected the request (HTTP ${status}).`
  if (status === 429) return `The extension catalog at ${url.host} is rate limiting requests. Try again shortly.`
  if (status >= 500)
    return `The extension catalog at ${url.host} is unavailable right now (HTTP ${status}). Try again later.`
  return `The extension catalog at ${url.host} returned HTTP ${status}.`
}

async function catalogFetch(url: URL, signal: AbortSignal, fetcher: CatalogFetch) {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT)
  try {
    return await fetcher(url, {
      signal: AbortSignal.any([signal, timeout]),
      headers: { Accept: "application/json" },
    })
  } catch (cause) {
    if (signal.aborted) throw cause
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new Error(catalogNetworkMessage(url, cause, timeout.aborted), { cause })
  }
}

async function readCatalogJson(response: Response, url: URL, signal: AbortSignal) {
  try {
    return (await response.json()) as unknown
  } catch (cause) {
    if (signal.aborted) throw cause
    if (!(cause instanceof SyntaxError)) throw new Error(catalogNetworkMessage(url, cause, false), { cause })
    throw new Error(`The extension catalog at ${url.host} returned an invalid response.`, { cause })
  }
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
    const response = await catalogFetch(url, signal, fetcher)
    trace?.("catalog.api.responded", { status: response.status, cursor: cursor ?? null })
    if (!response.ok) throw new Error(catalogHttpMessage(response.status, url))
    const data = await readCatalogJson(response, url, signal)
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
  const response = await catalogFetch(url, signal, fetcher)
  trace?.("catalog.registry.responded", { status: response.status })
  if (response.status === 403 || response.status === 404) {
    signal.throwIfAborted()
    trace?.("catalog.registry.fallback", { status: response.status })
    return loadCatalogApi(endpoint, signal, fetcher, trace)
  }
  if (!response.ok) throw new Error(catalogHttpMessage(response.status, url))
  const data = await readCatalogJson(response, url, signal)
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
