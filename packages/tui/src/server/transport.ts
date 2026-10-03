import { checkDirectory, parseResponse, validateResponse } from "../response-validation"
import { UNSAFE_TEXT } from "../response-validation/primitives"
import type { ConnectionOptions } from "./context"

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
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    // Bun's fetch reads NO_PROXY at request time; an empty proxy option still
    // uses shell proxies. Keep local credentials direct and retain other rules.
    const bypass = [process.env.NO_PROXY ?? "", process.env.no_proxy ?? "", "127.0.0.1,localhost,::1"]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
    process.env.NO_PROXY = [...new Set(bypass)].join(",")
    process.env.no_proxy = process.env.NO_PROXY
  }
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

/**
 * Fetch with a 10 s timeout, no redirects, and bounded response bytes. Responses are validated and
 * sanitized before the generated client's JSON parser sees them.
 */
export function createTransport(controller: AbortController) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10000),
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
      const body = await readLimited(response.body)
      if (response.ok) {
        const address = new URL(input instanceof Request ? input.url : input.toString())
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

async function readLimited(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 8 * 1024 * 1024) throw new Error("Server response exceeds the 8 MiB TUI limit.")
      if (chunks.length >= 8192) throw new Error("Server response exceeds the 8,192 chunk TUI limit.")
      chunks.push(new Uint8Array(chunk.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return new Blob(chunks)
}

export function inputDirectory(value: unknown) {
  try {
    checkDirectory(value)
  } catch {
    throw new Error("Enter an absolute directory on the server, such as /srv/project.")
  }
}
