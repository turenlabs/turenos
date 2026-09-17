import { Flag } from "@turenlabs/core/flag/flag"
import type { HttpServerRequest } from "effect/unstable/http"

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  )
}

export function isLocalPlacement(input: {
  readonly workspaceID?: string
  readonly inProcess: boolean
  readonly remoteAddress?: string
}) {
  if (input.workspaceID) return false
  if (input.inProcess) return true
  const address = input.remoteAddress?.toLowerCase()
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

/**
 * Whether the request came from a trusted local caller: an in-process `Request`
 * (the `Server.Default()` web-handler path) or a direct loopback socket. When the
 * server is pinned to a remote workspace (`FORGE_WORKSPACE_ID`) no request counts
 * as local.
 */
export function isLocalRequest(request: HttpServerRequest.HttpServerRequest) {
  const source = request.source
  const remoteAddress =
    source && typeof source === "object" && "socket" in source
      ? (source.socket as { readonly remoteAddress?: string } | undefined)?.remoteAddress
      : undefined
  return isLocalPlacement({
    workspaceID: Flag.FORGE_WORKSPACE_ID,
    inProcess: source instanceof Request,
    remoteAddress,
  })
}
