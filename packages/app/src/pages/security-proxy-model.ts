import { Schema } from "effect"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { ProxyPolicy } from "@turenlabs/protocol/proxy-policy"
import { diffLines, diffWordsWithSpace } from "diff"

export type Draft = {
  url: string
  method: string
  headers: string
  body: string
  encoding: SecurityProxy.Body["encoding"]
  status: string
  complete: boolean
}

export type RepeaterTab = {
  id: string
  name: string
  flowID: string
  draft: Draft
  auth: "captured" | "live"
  raw: string
  results: SecurityProxy.Flow[]
  resultID: string
}

export function repeaterTab(flow: SecurityProxy.Flow): RepeaterTab {
  return {
    id: crypto.randomUUID(),
    name: `${flow.request.method} ${URL.parse(flow.request.url)?.pathname ?? "/"}`,
    flowID: flow.id,
    draft: {
      url: flow.request.url,
      method: flow.request.method,
      headers: JSON.stringify(editableHeaders(flow.request.headers), null, 2),
      body: flow.request.body.data,
      encoding: flow.request.body.encoding,
      status: "200",
      complete: flow.request.body.state === "complete",
    },
    auth: "captured",
    raw: "",
    results: [],
    resultID: "",
  }
}

export function duplicateRepeaterTab(tab: RepeaterTab): RepeaterTab {
  return {
    ...tab,
    id: crypto.randomUUID(),
    name: `${tab.name} copy`,
    draft: { ...tab.draft },
    results: [],
    resultID: "",
  }
}

// These headers belong to the transport, not the editable message.
// ":"-prefixed names are HTTP/2 pseudo-headers derived from the method and URL.
const framing = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "trailer",
  "te",
])
export function editableHeaders(headers: readonly SecurityProxy.Header[]) {
  return headers.filter((header) => !header.name.startsWith(":") && !framing.has(header.name.toLowerCase()))
}

export function canEditNote(existing: string, revealed: boolean) {
  return revealed || existing === ""
}

// Bindings and case storage scope by the exact owner identity, so the owner
// must match the tool's construction: session Location directory and
// workspaceID. The project-list path can differ (WSL mounts, symlinked roots)
// and lacks workspaceID, which splits the panel onto an empty scope.
export function proxyOwner(input: {
  directory: string
  session?: { directory: string; workspaceID?: string }
  sessionID?: string
}): SecurityProxy.Owner {
  return {
    directory: input.session?.directory || input.directory,
    ...(input.session?.workspaceID ? { workspaceID: input.session.workspaceID } : {}),
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  }
}

export function parseHeaders(text: string) {
  const headers = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(SecurityProxy.Headers)))(
    text,
  )
  ProxyPolicy.validateEdits({ headers })
  if (headers.some((header) => framing.has(header.name.toLowerCase())))
    throw new Error("Remove transport-controlled headers.")
  return headers
}

// Accepts a pasted raw HTTP request (Burp "paste", curl --raw output, devtools copy).
// Returns undefined when the request line or a resolvable origin is missing.
export function parseRawRequest(input: string) {
  const [head = "", ...rest] = input.replace(/\r\n/g, "\n").split("\n\n")
  const lines = head.split("\n").filter((line) => line.trim())
  const [method = "", target = ""] = lines.shift()?.trim().split(/\s+/) ?? []
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(method) || !target) return undefined
  const headers = lines.flatMap((line) => {
    const split = line.indexOf(":")
    return split === -1 ? [] : [{ name: line.slice(0, split).trim(), value: line.slice(split + 1).trim() }]
  })
  const host = headers.find((item) => item.name.toLowerCase() === "host")?.value ?? ""
  const url = /^https?:\/\//i.test(target)
    ? target
    : host
      ? `https://${host}${target.startsWith("/") ? target : `/${target}`}`
      : ""
  if (!url) return undefined
  return { url, method, headers, body: rest.join("\n\n") }
}

export function codec(input: string, format: "URL" | "Base64" | "Hex", decode: boolean) {
  if (format === "URL") return decode ? decodeURIComponent(input) : encodeURIComponent(input)
  if (!decode) {
    const bytes = new TextEncoder().encode(input)
    return format === "Hex"
      ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
      : btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
  }
  if (format === "Hex" && !/^(?:[\da-fA-F]{2})*$/.test(input)) throw new Error("Hex requires complete byte pairs.")
  const bytes =
    format === "Hex"
      ? Uint8Array.from(input.match(/../g) ?? [], (pair) => parseInt(pair, 16))
      : Uint8Array.from(atob(input), (char) => char.charCodeAt(0))
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export function editedBody(data: string, encoding: SecurityProxy.Body["encoding"]): SecurityProxy.Body {
  const size = encoding === "base64" ? atob(data).length : new TextEncoder().encode(data).length
  if (size > 1_048_576) throw new Error("Body exceeds the 1 MiB editing limit.")
  return { data, encoding, state: "complete", size }
}

export function previewRule(text: string, rule: SecurityProxy.Rule) {
  if (!rule.enabled || rule.action !== "replace" || !rule.find) return text
  try {
    return ProxyPolicy.replaceLiteral(text, rule.find, rule.replace)
  } catch {
    return "Preview exceeds the supported text or replacement size."
  }
}

export function compareFlows(left: SecurityProxy.Flow, right: SecurityProxy.Flow, hex: boolean, words = false) {
  const bytes = (flow: SecurityProxy.Flow) =>
    flow.responseBody.encoding === "base64"
      ? Uint8Array.from(atob(flow.responseBody.data), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(flow.responseBody.data)
  const leftBytes = bytes(left)
  const rightBytes = bytes(right)
  const render = (flow: SecurityProxy.Flow, bytes: Uint8Array) => {
    const body = flow.responseBody
    const content = hex
      ? Array.from({ length: Math.ceil(Math.min(bytes.length, 65536) / 16) }, (_, row) =>
          Array.from(bytes.subarray(row * 16, row * 16 + 16), (byte) => byte.toString(16).padStart(2, "0")).join(" "),
        ).join("\n")
      : new TextDecoder().decode(bytes.subarray(0, 65536))
    return `${flow.status ?? flow.state} · ${flow.state} · ${body.state}\n${JSON.stringify(flow.responseHeaders, null, 2)}\n\n${content}`
  }
  const leftText = render(left, leftBytes)
  const rightText = render(right, rightBytes)
  const options = { timeout: 100, maxEditLength: 4000 }
  const changes =
    words && !hex ? diffWordsWithSpace(leftText, rightText, options) : diffLines(leftText, rightText, options)
  const bounded = leftBytes.length > 65536 || rightBytes.length > 65536
  return {
    left: `${left.id}\n${leftText}`,
    right: `${right.id}\n${rightText}`,
    changes: changes ?? [],
    limited: !changes || bounded,
    equal:
      !bounded &&
      left.responseBody.state === "complete" &&
      right.responseBody.state === "complete" &&
      left.state === "complete" &&
      right.state === "complete" &&
      leftBytes.length === rightBytes.length &&
      leftBytes.every((byte, index) => byte === rightBytes[index]) &&
      leftText === rightText,
  }
}

export function harEntry(flow: SecurityProxy.Flow) {
  const requestType = flow.request.headers.find((item) => item.name.toLowerCase() === "content-type")?.value ?? ""
  const responseType = flow.responseHeaders.find((item) => item.name.toLowerCase() === "content-type")?.value ?? ""
  return {
    startedDateTime: new Date(flow.createdAt).toISOString(),
    time: flow.durationMs ?? 0,
    request: {
      method: flow.request.method,
      url: flow.request.url,
      httpVersion: "",
      cookies: [],
      headers: flow.request.headers,
      queryString: Array.from(new URL(flow.request.url).searchParams, ([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: flow.request.body.size,
      ...(flow.request.body.state === "complete" || flow.request.body.state === "truncated"
        ? { postData: { mimeType: requestType, text: flow.request.body.data, _encoding: flow.request.body.encoding } }
        : {}),
      _bodyState: flow.request.body.state,
    },
    response: {
      status: flow.status ?? 0,
      statusText: "",
      httpVersion: "",
      cookies: [],
      headers: flow.responseHeaders,
      content: {
        size: flow.responseBody.size,
        mimeType: responseType,
        text: flow.responseBody.data,
        ...(flow.responseBody.encoding === "base64" ? { encoding: "base64" } : {}),
        _bodyState: flow.responseBody.state,
      },
      redirectURL: flow.responseHeaders.find((item) => item.name.toLowerCase() === "location")?.value ?? "",
      headersSize: -1,
      bodySize: flow.responseBody.size,
    },
    cache: {},
    timings: { send: -1, wait: flow.durationMs ?? -1, receive: -1 },
    comment: flow.note,
    _flowID: flow.id,
    _parentID: flow.parentID,
    _source: flow.source,
    _state: flow.state,
    _error: flow.error,
  }
}

export function caseExport(input: {
  format: "json" | "har"
  visibility: "masked" | "revealed"
  case: Pick<SecurityProxy.Case, "id" | "name" | "createdAt">
  filter?: SecurityProxy.FlowFilter
}) {
  const metadata = {
    version: 1,
    visibility: input.visibility,
    exportedAt: new Date().toISOString(),
    case: input.case,
    filter: input.filter,
  }
  const parts = [
    input.format === "har"
      ? `{"log":{"version":"1.2","creator":{"name":"TurenOS","version":"1"},"_turen":${JSON.stringify(metadata)},"entries":[`
      : `{"format":"turen-security-case",${JSON.stringify(metadata).slice(1, -1)},"flows":[`,
  ]
  let count = 0
  return {
    get count() {
      return count
    },
    append(flows: readonly SecurityProxy.Flow[]) {
      flows.forEach((flow) => {
        parts.push(`${count ? "," : ""}${JSON.stringify(input.format === "har" ? harEntry(flow) : flow)}`)
        count++
      })
    },
    finish() {
      return new Blob([...parts, input.format === "har" ? "]}}" : "]}"], { type: "application/json" })
    },
  }
}
