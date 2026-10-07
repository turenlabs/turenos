import { checkDirectory, isRecord, parseResponse } from "./response-validation"
import { readBounded } from "./response-validation/body"

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  /** The server directory the request acts in; session routes use the session's own. */
  directory?: string
  query?: Record<string, string | number | undefined>
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
  /** The body carries a credential, so the route needs HTTPS or numeric loopback like the provider routes. */
  secret?: boolean
  /** Cancel the body unread: a configuration write answers with the whole configuration. */
  discard?: boolean
}

/**
 * JSON requests for server routes the generated client does not cover (the desktop still calls
 * them through its legacy SDK). Callers validate the shapes they display; this layer bounds size
 * and nesting, never follows redirects, and turns HTTP failures into readable errors.
 */
export function createApi(input: { url: URL; headers: Headers; signal: AbortSignal }) {
  const loopback = input.url.hostname === "127.0.0.1" || input.url.hostname === "[::1]"
  const secure = input.url.protocol === "https:" || loopback
  return async function request(path: string, options: Options = {}): Promise<unknown> {
    if (options.secret && !secure)
      throw new Error("Credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
    const address = new URL(path, input.url)
    if (options.directory !== undefined) {
      checkDirectory(options.directory)
      address.searchParams.set("directory", options.directory)
    }
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) address.searchParams.set(key, String(value))
    const headers = new Headers(input.headers)
    headers.set("Accept", "application/json")
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
    if (options.body !== undefined) headers.set("Content-Type", "application/json")
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(options.timeout ?? 10000),
      ...(options.signal ? [options.signal] : []),
    ])
    const response = await fetch(address, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "error",
    }).catch(() => {
      throw new Error(signal.aborted ? "The server did not answer in time." : "Connection failed. Check the server.")
    })
    if (options.discard) return discarded(response)
    const text = response.body ? await new Blob(await readBounded(response.body)).text() : ""
    if (response.status === 401 || response.status === 403)
      throw new Error("Authentication required. Check the server credentials.")
    if (!response.ok) throw new Error(failure(response.status, text))
    if (response.status === 204 || !text) return undefined
    return parseResponse(text)
  }
}

export type Api = ReturnType<typeof createApi>

/** Drops a body that must never be read, such as the full configuration a config write returns. */
async function discarded(response: Response) {
  await response.body?.cancel().catch(() => {})
  if (response.status === 401 || response.status === 403)
    throw new Error("Authentication required. Check the server credentials.")
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`)
  return undefined
}

/** The server's own message when it sent one, such as a NotFoundError or InvalidRequestError. */
function failure(status: number, text: string) {
  const body = parseJSON(text)
  const message = [isRecord(body) && body.message, isRecord(body) && isRecord(body.data) && body.data.message].find(
    (value): value is string => typeof value === "string",
  )
  const detail = (message ?? (text.startsWith("<") ? "" : text)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
  return `Server returned HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : "."}`
}

export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
