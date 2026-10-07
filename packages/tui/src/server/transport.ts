import { checkDirectory, parseResponse, validateResponse } from "../response-validation"
import { readBounded } from "../response-validation/body"
import { UNSAFE_TEXT } from "../response-validation/primitives"
import type { ConnectionOptions } from "./context"
import { bypassLoopbackProxy } from "./proxy"

/** Checks the server URL and credential policy and returns the origin and the Basic-auth username. */
export function validateConnection(options: ConnectionOptions) {
  const url = new URL(options.url)
  if (url.pathname !== "/") throw new Error("Use the server's origin URL without a path prefix.")
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) server URL without credentials, a query, or a fragment.")
  }
  // Match the CLI's credential policy for callers that bypass its early validation.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (options.password && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
  }
  bypassLoopbackProxy(url)
  if (options.directory !== undefined) inputDirectory(options.directory)
  const username = options.username ?? "forge"
  if (!username || username.length > 512 || username.includes(":") || UNSAFE_TEXT.test(username))
    throw new Error("Use a valid username without ':' or control characters.")
  return { url, username }
}

export function basicAuthHeaders(username: string, password: string | undefined) {
  const headers = new Headers()
  if (password) {
    headers.set("Authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
  }
  return headers
}

const defaultTimeout = 10_000
// The server runs `/shell` for up to 120 s by default; wait that long plus a margin, so a slow
// command is in flight under its message ID rather than a connection error.
const shellTimeout = 130_000
// Compaction calls the session's model and has no request ID, so it must not time out into a retry.
const compactTimeout = 600_000

/** How long one request may take: long for the routes whose work runs server-side, 10 s otherwise. */
export function requestTimeout(address: URL, method: string | undefined) {
  if (method !== "POST") return defaultTimeout
  if (/^\/api\/session\/[^/]+\/shell$/.test(address.pathname)) return shellTimeout
  if (/^\/api\/session\/[^/]+\/compact$/.test(address.pathname)) return compactTimeout
  return defaultTimeout
}

/**
 * Fetch with a per-route timeout (10 s unless requestTimeout says otherwise), no redirects, and bounded response bytes. Responses are validated and
 * sanitized before the generated client's JSON parser sees them.
 */
export function createTransport(controller: AbortController) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const address = new URL(input instanceof Request ? input.url : input.toString())
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(requestTimeout(address, init?.method ?? (input instanceof Request ? input.method : "GET"))),
        ...(init?.signal ? [init.signal] : []),
      ])
      // Never forward server credentials to a redirect target. Limit decoded
      // response bytes before the generated client's JSON parser sees them.
      const response = await fetch(input, { ...init, signal, redirect: "error" })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        return Response.json(
          { _tag: "UnauthorizedError", message: "Authentication required. Check the server credentials." },
          { status: response.status },
        )
      }
      if (response.status === 204 || response.status === 205 || !response.body) return response
      const body = new Blob(await readBounded(response.body))
      if (response.ok) {
        // This root API has its own strict State/value parser in working-folders.
        if (address.pathname === "/global/storage")
          return new Response(body, { status: response.status, headers: response.headers })
        const sanitized = validateResponse(address, init, parseResponse(await body.text()))
        if (sanitized !== undefined) return Response.json(sanitized, { status: response.status })
      }
      return new Response(body, { status: response.status, headers: response.headers })
    },
    { preconnect: fetch.preconnect },
  )
}

export function inputDirectory(value: unknown) {
  try {
    checkDirectory(value)
  } catch {
    throw new Error("Enter an absolute directory on the server, such as /srv/project.")
  }
}
