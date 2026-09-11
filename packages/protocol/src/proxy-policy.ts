export * as ProxyPolicy from "./proxy-policy"

import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

export const BODY_LIMIT = 1024 * 1024
const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i
const secretField = /token|password|passwd|secret|session|authorization|api.?key/i

export function url(value: string) {
  const parsed = URL.parse(value)
  if (
    !parsed ||
    value.length > 4096 ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("A credential-free HTTP(S) URL is required")
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new Error("Invalid URL characters")
  parsed.hash = ""
  return parsed
}

export function matches(value: string, prefix: string) {
  try {
    const target = url(value)
    const allowed = url(prefix)
    if (target.origin !== allowed.origin) return false
    const pathname = (path: string) => {
      const decoded = decodeURIComponent(path)
      if (/[\u0000-\u001f\u007f\\?#]/.test(decoded) || decoded.startsWith("//")) throw new Error("Invalid path")
      return new URL(decoded, "https://scope.invalid").pathname
    }
    const base = pathname(allowed.pathname).replace(/\/$/, "")
    const path = pathname(target.pathname)
    return !base || path === base || path.startsWith(`${base}/`)
  } catch {
    return false
  }
}

export function requireCreate(input: SecurityProxy.Create) {
  if (!input.name.trim()) throw new Error("Name is required")
  return { ...input, name: input.name.trim() }
}

export function bytes(body: SecurityProxy.Body) {
  if (body.state !== "complete") throw new Error("Body is incomplete; it cannot be sent")
  const result =
    body.encoding === "utf8"
      ? new TextEncoder().encode(body.data)
      : Uint8Array.from(atob(body.data), (value) => value.charCodeAt(0))
  if (result.byteLength > BODY_LIMIT) throw new Error("Body exceeds the 1 MiB limit")
  return result
}

export function validateEdits(edits: SecurityProxy.Edits) {
  if (edits.url !== undefined) url(edits.url)
  if (edits.method !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(edits.method))
    throw new Error("Invalid HTTP method")
  if (edits.headers) {
    if (edits.headers.length > 256 || new TextEncoder().encode(JSON.stringify(edits.headers)).byteLength > 65536)
      throw new Error("Headers exceed the limit")
    edits.headers.forEach((header) => {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || /[\r\n\0]/.test(header.value))
        throw new Error("Invalid HTTP header")
      if (["host", "content-length", "transfer-encoding", "connection"].includes(header.name.toLowerCase()))
        throw new Error("Framing headers are managed by the transport")
      if (header.value === "[REDACTED]") throw new Error("Reveal protected headers before replacing them")
    })
  }
  if (edits.body) bytes(edits.body)
  if (edits.status !== undefined && (!Number.isInteger(edits.status) || edits.status < 200 || edits.status > 599))
    throw new Error("Response status must be 200-599")
}

export function publicURL(value: string) {
  const parsed = URL.parse(value)
  if (!parsed) return "[invalid URL]"
  parsed.username = ""
  parsed.password = ""
  parsed.hash = ""
  for (const key of new Set(parsed.searchParams.keys())) {
    if (secretField.test(key)) parsed.searchParams.set(key, "[REDACTED]")
  }
  return parsed.href
}

export function replaceLiteral(input: string, find: string, replacement: string) {
  if (!find) return input
  const encoder = new TextEncoder()
  if (encoder.encode(input).byteLength > 65536) throw new Error("Literal replacement requires text within 64 KiB")
  const parts = input.split(find)
  const size = parts.reduce(
    (total, part) => total + encoder.encode(part).byteLength,
    (parts.length - 1) * encoder.encode(replacement).byteLength,
  )
  if (size > BODY_LIMIT) throw new Error("Literal replacement would exceed 1 MiB")
  return parts.join(replacement)
}

export function publicHeaders(headers: readonly SecurityProxy.Header[]) {
  return headers.map((header) => ({ ...header, value: sensitive.test(header.name) ? "[REDACTED]" : header.value }))
}

export function publicBody(body: SecurityProxy.Body): SecurityProxy.Body {
  if (body.encoding === "base64") return { ...body, data: "", state: "unavailable" }
  return {
    ...body,
    data: body.data
      .slice(0, 65536)
      .replace(
        /("[^"\n]*(?:token|password|passwd|secret|session|api[_-]?key)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[REDACTED]"',
      )
      .replace(/((?:password|token|secret|api[_-]?key)=)[^&\s]*/gi, "$1[REDACTED]"),
    state: body.data.length > 65536 ? "truncated" : body.state,
  }
}

export function publicMessage(message: SecurityProxy.Message): SecurityProxy.Message {
  return {
    ...message,
    url: publicURL(message.url),
    headers: publicHeaders(message.headers),
    body: publicBody(message.body),
  }
}

export function publicFlow(flow: SecurityProxy.Flow): SecurityProxy.Flow {
  return {
    ...flow,
    request: publicMessage(flow.request),
    ...(flow.originalRequest ? { originalRequest: publicMessage(flow.originalRequest) } : {}),
    responseHeaders: publicHeaders(flow.responseHeaders),
    responseBody: publicBody(flow.responseBody),
    ...(flow.originalResponse
      ? {
          originalResponse: {
            ...flow.originalResponse,
            headers: publicHeaders(flow.originalResponse.headers),
            body: publicBody(flow.originalResponse.body),
          },
        }
      : {}),
  }
}
