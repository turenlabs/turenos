import { Schema } from "effect"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { ProxyPolicy } from "@turenlabs/protocol/proxy-policy"

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

export function compareFlows(left: SecurityProxy.Flow, right: SecurityProxy.Flow, hex: boolean) {
  const render = (flow: SecurityProxy.Flow) => {
    const body = flow.responseBody
    const bytes =
      body.encoding === "base64"
        ? Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(body.data)
    const content = hex
      ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")
      : new TextDecoder().decode(bytes)
    return `${flow.id} · ${flow.status ?? flow.state} · ${body.state}\n${JSON.stringify(flow.responseHeaders, null, 2)}\n\n${content}`
  }
  const leftText = render(left)
  const rightText = render(right)
  return {
    left: leftText,
    right: rightText,
    equal:
      left.responseBody.state === "complete" &&
      right.responseBody.state === "complete" &&
      left.status === right.status &&
      left.state === right.state &&
      leftText.slice(leftText.indexOf("\n")) === rightText.slice(rightText.indexOf("\n")),
  }
}
