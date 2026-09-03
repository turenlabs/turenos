import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { ProviderConnectionPolicy } from "@/provider/connection-policy"
import { classifyAddress } from "@/util/ip-address"

/**
 * Shared HTTP helper for data integrations: JSON/text fetch with timeout,
 * retry-on-429/5xx with backoff, and a two-level (memory + disk) cache.
 *
 * Integrations should always go through this module rather than calling
 * `fetch` directly so caching, retries, and the User-Agent are uniform.
 */

export const USER_AGENT = "forge-security"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_ATTEMPTS = 3
const MAX_BACKOFF_MS = 30_000
const MEMORY_MAX_ENTRIES = 512
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const FIXED_POLICY_TTL_MS = 60 * 60_000

export class HttpError extends Error {
  readonly url: string
  readonly status: number

  constructor(url: string, status: number, body?: string) {
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 200)}` : ""}`)
    this.name = "SecurityHttpError"
    this.url = url
    this.status = status
  }
}

export interface CacheOptions {
  /** On-disk cache directory, usually `ctx.cacheDir`. */
  dir: string
  /** Time-to-live in milliseconds. */
  ttlMs: number
  /** Explicit cache key; defaults to a hash of method + url + body. */
  key?: string
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  /** Request body; non-string values are JSON.stringified. */
  body?: unknown
  /** Per-attempt timeout in ms (default 30s). */
  timeoutMs?: number
  /** Max attempts including the first (default 3). Retries on 429, 5xx, and network errors. */
  attempts?: number
  /** Maximum decoded response bytes accepted before parsing (default 64 MiB). */
  maxResponseBytes?: number
  /** Audited origin and path boundary for fixed external data adapters. */
  fixedEndpoint?: {
    id: string
    endpoint: string
    pathPrefix?: string
  }
  cache?: CacheOptions
}

interface CacheEntry {
  expires: number
  value: unknown
}

const memory = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()
const fixedTransports = new Map<
  string,
  {
    expiresAt: number
    request: ReturnType<typeof ProviderConnectionPolicy.createConnectionPolicyFetchForEndpoint>
  }
>()

function remember(key: string, entry: CacheEntry) {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) memory.delete(oldest)
  }
  memory.set(key, entry)
}

function cacheKey(url: string, opts: RequestOptions, accept: "json" | "text") {
  if (opts.cache?.key) return `${accept}:${opts.cache.key}`
  const body = typeof opts.body === "string" ? opts.body : opts.body === undefined ? "" : JSON.stringify(opts.body)
  const headers = JSON.stringify(
    Object.entries(opts.headers ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
  )
  return crypto
    .createHash("sha256")
    .update(`${accept} ${opts.method ?? "GET"} ${url} ${headers} ${body}`)
    .digest("hex")
}

function cacheFile(dir: string, key: string) {
  return path.join(dir, `${key}.json`)
}

async function readCache(key: string, cache: CacheOptions): Promise<CacheEntry | undefined> {
  const now = Date.now()
  const hit = memory.get(key)
  if (hit) {
    if (hit.expires > now) return hit
    memory.delete(key)
  }
  try {
    const raw = await fs.readFile(cacheFile(cache.dir, key), "utf8")
    // batou:ignore deserialize -- JSON.parse (the safe API this rule recommends) on a cache file this module wrote itself; path is a sha256 hex digest under our own cache dir, and corrupt content is caught + treated as a miss
    const entry = JSON.parse(raw) as CacheEntry
    if (typeof entry?.expires === "number" && entry.expires > now) {
      remember(key, entry)
      return entry
    }
  } catch {
    // missing or corrupt cache file: treat as a miss
  }
  return undefined
}

async function writeCache(key: string, cache: CacheOptions, value: unknown) {
  const entry: CacheEntry = { expires: Date.now() + cache.ttlMs, value }
  remember(key, entry)
  try {
    await fs.mkdir(cache.dir, { recursive: true })
    const file = cacheFile(cache.dir, key)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entry))
    await fs.rename(tmp, file)
  } catch {
    // disk cache is best-effort; memory cache already updated
  }
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS)
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, MAX_BACKOFF_MS)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function fixedEndpointRequest(options: NonNullable<RequestOptions["fixedEndpoint"]>) {
  const key = `${options.id}\0${options.endpoint}\0${options.pathPrefix ?? "/"}`
  const current = fixedTransports.get(key)
  if (current && current.expiresAt > Date.now()) return current.request
  if (current)
    void current.request.then(
      (request) => request.close(),
      () => {},
    )

  const expiresAt = Date.now() + FIXED_POLICY_TTL_MS
  const request = ProviderConnectionPolicy.createConnectionPolicyFetchForEndpoint({
    id: `security-data:${options.id}`,
    endpoint: options.endpoint,
    pathPrefix: options.pathPrefix,
    expiresAt,
    noAddressesMessage: `${options.id} endpoint DNS returned no addresses`,
    validateAddresses: (addresses) => {
      if (!addresses.every((address) => classifyAddress(address.toLowerCase()) === "public")) {
        throw new Error(`${options.id} endpoint must resolve only to public addresses`)
      }
    },
  }).catch((error) => {
    if (fixedTransports.get(key)?.request === request) fixedTransports.delete(key)
    throw error
  })
  fixedTransports.set(key, { expiresAt, request })
  return request
}

async function responseValue(response: Response, accept: "json" | "text", maxBytes: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response exceeded ${maxBytes} bytes`)
  }
  if (!response.body) return accept === "json" ? undefined : ""

  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`response exceeded ${maxBytes} bytes`)
    }
    chunks.push(next.value)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return accept === "json" ? JSON.parse(text) : text
}

async function request(url: string, opts: RequestOptions, accept: "json" | "text"): Promise<unknown> {
  const cache = opts.cache
  if (!cache) return requestUpstream(url, opts, accept)
  const key = cacheKey(url, opts, accept)
  const hit = await readCache(key, cache)
  if (hit) return hit.value
  const pending = inflight.get(key)
  if (pending) return pending

  const next = requestUpstream(url, opts, accept)
    .then(async (value) => {
      await writeCache(key, cache, value)
      return value
    })
    .finally(() => {
      if (inflight.get(key) === next) inflight.delete(key)
    })
  inflight.set(key, next)
  return next
}

async function requestUpstream(url: string, opts: RequestOptions, accept: "json" | "text") {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const body = opts.body === undefined || typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
  const transport = opts.fixedEndpoint ? await fixedEndpointRequest(opts.fixedEndpoint) : fetch

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response
    try {
      response = await transport(url, {
        method: opts.method ?? "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: accept === "json" ? "application/json" : "*/*",
          ...(body !== undefined && typeof opts.body !== "string" ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // network error or timeout: retry with backoff
      lastError = error
      if (attempt + 1 < attempts) await sleep(retryDelay(attempt, null))
      continue
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new HttpError(url, response.status)
      if (attempt + 1 < attempts) {
        await sleep(retryDelay(attempt, response.headers.get("retry-after")))
        continue
      }
      break
    }

    if (!response.ok) {
      const text = await responseValue(response, "text", Math.min(maxResponseBytes, 8_192)).catch(() => "")
      throw new HttpError(url, response.status, text)
    }

    return responseValue(response, accept, maxResponseBytes)
  }

  if (lastError instanceof Error) throw lastError
  throw new Error(`request failed: ${url}`)
}

/** GET/POST a JSON endpoint. Caches the parsed body when `opts.cache` is set. */
export async function fetchJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  return (await request(url, opts, "json")) as T
}

/** Fetch a text/CSV endpoint (e.g. feed downloads). Caches when `opts.cache` is set. */
export async function fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
  return (await request(url, opts, "text")) as string
}

export * as SecurityHttp from "./http"
