import type { ForgeClient, PermissionRequest, PermissionV2Request } from "@turenlabs/sdk/v2/client"

// Session Core raises `permission.v2.asked` (action/resources/save) while the legacy runtime raises
// `permission.asked`. Both are held in one per-session store so every prompt surface renders either one;
// `runtime` sends the reply back to the service that is actually waiting on it.
export type SessionPermissionRequest = PermissionRequest & { runtime?: "v2" }

export function permissionFromV2(request: PermissionV2Request): SessionPermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    metadata: request.metadata ?? {},
    always: request.save ?? [],
    tool: request.source && { messageID: request.source.messageID, callID: request.source.callID },
    runtime: "v2",
  }
}

export function replyToPermission(
  client: ForgeClient,
  request: SessionPermissionRequest,
  reply: "once" | "always" | "reject",
) {
  if (request.runtime === "v2")
    return client.v2.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply })
  return client.permission.respond({ sessionID: request.sessionID, permissionID: request.id, response: reply })
}
