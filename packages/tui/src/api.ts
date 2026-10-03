import { checkDirectory, isRecord, parseResponse } from "./response-validation"

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  /** The server directory the request acts in; session routes use the session's own. */
  directory?: string
  query?: Record<string, string | number | undefined>
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
}

/**
 * JSON requests for server routes the generated client does not cover (the desktop still calls
 * them through its legacy SDK). Callers validate the shapes they display; this layer bounds size
 * and nesting, never follows redirects, and turns HTTP failures into readable errors.
 */
export function createApi(input: { url: URL; headers: Headers; signal: AbortSignal }) {
  return async function request(path: string, options: Options = {}): Promise<unknown> {
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
    const text = await bounded(response)
    if (response.status === 401 || response.status === 403)
      throw new Error("Authentication required. Check the server credentials.")
    if (!response.ok) throw new Error(failure(response.status, text))
    if (response.status === 204 || !text) return undefined
    return parseResponse(text)
  }
}

export type Api = ReturnType<typeof createApi>

async function bounded(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 8 * 1024 * 1024) throw new Error("Server response exceeds the 8 MiB TUI limit.")
      chunks.push(new Uint8Array(chunk.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return new Blob(chunks).text()
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
