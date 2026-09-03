import type { McpRuntimeBackendStatus } from "@turenlabs/sdk/v2/client"

export type McpRuntimeAction = "select" | "test" | "unavailable"

export function mcpRuntimeAction(backend: McpRuntimeBackendStatus): McpRuntimeAction {
  if (!backend.selectable) return "unavailable"
  if (backend.backend === "docker") return "test"
  return "select"
}

export function mcpRuntimeBackendName(backend: McpRuntimeBackendStatus) {
  if (backend.backend === "docker") return "Docker"
  if (backend.backend === "local") return "Local process"
  return "QEMU VM"
}
