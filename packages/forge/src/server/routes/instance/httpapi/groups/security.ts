import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { McpRuntime } from "@/mcp/runtime"
import { described } from "./metadata"

export const SecurityPaths = {
  mcpRuntime: "/global/security/mcp-runtime",
} as const

export const SecurityApi = HttpApi.make("security").add(
  HttpApiGroup.make("security")
    .add(
      HttpApiEndpoint.get("mcpRuntimeGet", SecurityPaths.mcpRuntime, {
        success: described(McpRuntime.Status, "MCP runtime status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "security.mcpRuntime.get",
          summary: "Get MCP runtime status",
          description: "Return persisted backend selection and non-secret Docker qualification state.",
        }),
      ),
      HttpApiEndpoint.patch("mcpRuntimeUpdate", SecurityPaths.mcpRuntime, {
        payload: McpRuntime.SettingsInput,
        success: described(McpRuntime.Status, "MCP runtime status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "security.mcpRuntime.update",
          summary: "Select MCP runtime backend",
          description:
            "Select Docker or explicitly opt into the trusted local-process fallback. QEMU is unavailable until a dedicated MCP VM service runtime exists.",
        }),
      ),
      HttpApiEndpoint.post("mcpRuntimeTest", `${SecurityPaths.mcpRuntime}/test`, {
        success: described(McpRuntime.Status, "MCP runtime status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "security.mcpRuntime.test",
          summary: "Test MCP Docker runtime",
          description:
            "Run bounded Docker CLI, daemon, and hardened-flag probes without pulling an image, mounting host paths, or accessing provider credentials.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "security", description: "Security integrations routes." })),
)
