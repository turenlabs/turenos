import { checkDirectory, invalid, parseResponse } from "../response-validation"
import { readBounded } from "../response-validation/body"
import { bypassLoopbackProxy } from "../server/proxy"

export type RequestInput = {
  method?: "PUT" | "PATCH" | "POST"
  body?: object
  directory?: string
  secret?: boolean
  discard?: boolean
  signal?: AbortSignal
}

/** Sends a provider-route request and answers with the parsed body, or nothing when `discard` is set. */
export type ProviderRequest = (path: string, input?: RequestInput) => Promise<unknown>

/** The provider adapter's connection: a validated origin, its request function, and whether it may carry secrets. */
export function providerConnection(options: { url: URL; headers: Headers; signal: AbortSignal }) {
  const url = providerOrigin(options.url)
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  const secure = url.protocol === "https:" || loopback
  bypassLoopbackProxy(url)
  async function request(path: string, input: RequestInput = {}): Promise<unknown> {
    if (!secure && (input.secret || headers.has("authorization") || headers.has("cookie")))
      throw new Error("Provider credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
    const address = new URL(path, url)
    if (input.directory !== undefined) {
      checkDirectory(input.directory)
      address.searchParams.set("directory", input.directory)
    }
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(path.endsWith("/oauth/callback") ? 300000 : 10000),
      ...(input.signal ? [input.signal] : []),
    ])
    const requestHeaders = new Headers(headers)
    if (input.body) requestHeaders.set("Content-Type", "application/json")
    const failed = () =>
      new Error(
        signal.aborted
          ? "Provider request cancelled or timed out."
          : "Provider request failed. Check the server connection; redirects are not permitted.",
      )
    if (signal.aborted) throw failed()
    const response = await fetch(address, {
      method: input.method ?? "GET",
      headers: requestHeaders,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal,
      redirect: "error",
    }).catch(() => {
      throw failed()
    })
    if (!response.ok || input.discard) {
      // Config PATCH returns the full config. Never read, parse, or retain it (or error bodies).
      await response.body?.cancel().catch(() => {})
      if (!response.ok) throw new Error(`Provider request failed (HTTP ${response.status}).`)
      return
    }
    if (!response.body) invalid("empty provider response")
    return parseResponse(await new Blob(await readBounded(response.body, { label: "Provider", failed })).text())
  }
  return { request, secure }
}

function providerOrigin(value: URL) {
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error("Use an HTTP(S) server origin without a path, credentials, query, or fragment.")
  return url
}
