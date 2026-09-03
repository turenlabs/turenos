import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export type ConnectionPolicy = {
  readonly id: string
  readonly origin: string
  readonly pathPrefix: string
  readonly pinnedAddresses: readonly string[]
  readonly expiresAt: number
  readonly credentialHash?: string
}

export class ConnectionPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderConnectionPolicyError"
  }
}

export type ConnectionPolicyDependencies = {
  readonly now: () => number
  readonly resolve: (hostname: string) => Promise<readonly string[]>
  readonly request: (url: URL, init: RequestInit, addresses: readonly string[]) => Promise<Response>
  readonly close?: () => void
}

export function connectionPolicyKey(policy: ConnectionPolicy) {
  return createHash("sha256")
    .update(JSON.stringify(normalizePolicy(policy)))
    .digest("hex")
}

export function createConnectionPolicyFetch(policy: ConnectionPolicy, provided?: ConnectionPolicyDependencies) {
  const normalized = normalizePolicy(policy)
  const dependencies = provided ?? production(normalized.expiresAt)
  let closed = false
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (closed) throw new ConnectionPolicyError("Connection policy transport retired")
    if (normalized.expiresAt <= dependencies.now()) throw new ConnectionPolicyError("Connection policy expired")
    const url = requestURL(input)
    assertRequest(normalized, url, init)
    const resolved = isIP(url.hostname)
      ? [normalizeAddress(url.hostname)]
      : [...new Set((await dependencies.resolve(url.hostname)).map(normalizeAddress))].sort()
    if (!resolved.length) throw new ConnectionPolicyError("Endpoint DNS returned no addresses")
    if (resolved.some((address) => !normalized.pinnedAddresses.includes(address)))
      throw new ConnectionPolicyError("Endpoint DNS changed after qualification")
    const response = await dependencies.request(url, { ...init, redirect: "manual" }, resolved)
    if (response.status >= 300 && response.status < 400)
      throw new ConnectionPolicyError("Endpoint redirects are prohibited")
    return response
  }
  request.close = () => {
    if (closed) return
    closed = true
    dependencies.close?.()
  }
  return request
}

export async function createConnectionPolicyFetchForEndpoint(
  input: {
    readonly id: string
    readonly endpoint: string
    readonly pathPrefix?: string
    readonly expiresAt?: number
    readonly noAddressesMessage?: string
    readonly validateAddresses?: (addresses: readonly string[]) => void
  },
  provided?: ConnectionPolicyDependencies,
) {
  let url: URL
  try {
    url = new URL(input.endpoint)
  } catch {
    throw new ConnectionPolicyError("Connection policy endpoint is invalid")
  }
  if (url.username || url.password || url.hash) throw new ConnectionPolicyError("Connection policy endpoint is invalid")

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const resolve = provided?.resolve ?? resolveDNS
  const addresses = isIP(hostname)
    ? [normalizeAddress(hostname)]
    : [...new Set((await resolve(hostname)).map(normalizeAddress))].sort()
  if (!addresses.length) {
    throw new ConnectionPolicyError(input.noAddressesMessage ?? "Endpoint DNS returned no addresses")
  }
  if (!addresses.every((address) => isIP(address))) {
    throw new ConnectionPolicyError("Connection policy requires pinned IP addresses")
  }
  input.validateAddresses?.(addresses)

  const now = provided?.now ?? Date.now
  return createConnectionPolicyFetch(
    {
      id: input.id,
      origin: url.origin,
      pathPrefix: input.pathPrefix ?? "/",
      pinnedAddresses: addresses,
      expiresAt: input.expiresAt ?? now() + 60 * 60_000,
    },
    provided,
  )
}

export function assertConnectionPolicyOptions(options: Record<string, unknown>) {
  const forbidden = ["fetch", "proxy", "dispatcher", "agent", "httpAgent", "httpsAgent", "httpProxy", "httpsProxy"]
  const configured = forbidden.find((key) => options[key] !== undefined && options[key] !== false)
  if (configured) throw new ConnectionPolicyError(`Connection policy prohibits provider option: ${configured}`)
}

function normalizePolicy(policy: ConnectionPolicy): ConnectionPolicy {
  const origin = new URL(policy.origin)
  if (
    !policy.id ||
    origin.origin !== policy.origin ||
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username ||
    origin.password
  )
    throw new ConnectionPolicyError("Connection policy origin is invalid")
  const pathPrefix = normalizePath(policy.pathPrefix)
  const pinnedAddresses = [...new Set(policy.pinnedAddresses.map(normalizeAddress))].sort()
  if (!pinnedAddresses.length || !pinnedAddresses.every((address) => isIP(address)))
    throw new ConnectionPolicyError("Connection policy requires pinned IP addresses")
  if (!Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= 0)
    throw new ConnectionPolicyError("Connection policy expiry is invalid")
  if (policy.credentialHash !== undefined && !/^[a-f0-9]{64}$/.test(policy.credentialHash))
    throw new ConnectionPolicyError("Connection policy credential fingerprint is invalid")
  if (origin.protocol === "http:" && (!isLoopbackAddress(origin.hostname) || !pinnedAddresses.every(isLoopbackAddress)))
    throw new ConnectionPolicyError("Remote connection policies require HTTPS")
  return Object.freeze({
    id: policy.id,
    origin: origin.origin,
    pathPrefix,
    pinnedAddresses: Object.freeze(pinnedAddresses),
    expiresAt: policy.expiresAt,
    ...(policy.credentialHash === undefined ? {} : { credentialHash: policy.credentialHash }),
  })
}

function requestURL(input: RequestInfo | URL) {
  if (input instanceof URL) return new URL(input)
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

function assertRequest(policy: ConnectionPolicy, url: URL, init?: RequestInit) {
  if (url.origin !== policy.origin) throw new ConnectionPolicyError("Request escaped its qualified origin")
  if (url.username || url.password) throw new ConnectionPolicyError("Request URL credentials are prohibited")
  if (
    policy.pathPrefix !== "/" &&
    url.pathname !== policy.pathPrefix &&
    !url.pathname.startsWith(`${policy.pathPrefix}/`)
  )
    throw new ConnectionPolicyError("Request escaped its qualified API path")
  const options = init as (RequestInit & Record<string, unknown>) | undefined
  if (options?.["proxy"] || options?.["dispatcher"] || options?.["agent"])
    throw new ConnectionPolicyError("Request-level proxy or dispatcher overrides are prohibited")
  const headers = new Headers(init?.headers)
  if (headers.has("proxy-authorization") || headers.has("proxy-connection"))
    throw new ConnectionPolicyError("Proxy headers are prohibited")
}

function normalizePath(value: string) {
  if (!value.startsWith("/")) throw new ConnectionPolicyError("Connection policy path is invalid")
  const normalized = value.replace(/\/+$/, "")
  return normalized || "/"
}

function normalizeAddress(value: string) {
  return value.replace(/^\[|\]$/g, "").toLowerCase()
}

function isLoopbackAddress(value: string) {
  const address = normalizeAddress(value)
  if (address === "localhost" || address === "::1") return true
  return isIP(address) === 4 && address.split(".")[0] === "127"
}

async function resolveDNS(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map((address) => address.address)
}

function production(expiresAt: number): ConnectionPolicyDependencies {
  const state: {
    addresses: readonly string[]
    agent?: import("undici").Agent
  } = { addresses: [] }
  const close = () => {
    const agent = state.agent
    state.agent = undefined
    if (agent && typeof agent.close === "function") void agent.close()
  }
  const remaining = Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647)
  const timer = setTimeout(close, remaining)
  timer.unref?.()
  return {
    now: Date.now,
    close,
    resolve: resolveDNS,
    request: async (url, init, addresses) => {
      const { Agent, fetch } = await import("undici")
      state.addresses = [...addresses].sort()
      const dispatcher =
        state.agent ??
        new Agent({
          connect: {
            autoSelectFamily: true,
            lookup(_hostname, options, callback) {
              const selected = state.addresses[0]!
              callback(
                null,
                options.all ? state.addresses.map((address) => ({ address, family: isIP(address) })) : selected,
                options.all ? undefined : isIP(selected),
              )
            },
          },
        })
      state.agent = dispatcher
      const request = {
        ...init,
        dispatcher,
        redirect: "manual",
      } as unknown as NonNullable<Parameters<typeof fetch>[1]>
      const response = await fetch(url, request)
      return response as unknown as Response
    },
  }
}

export * as ProviderConnectionPolicy from "./connection-policy"
