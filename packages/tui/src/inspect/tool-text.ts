import { array, object, string } from "../response-validation"
import { label } from "../state"

export function toolText(snapshot: Record<string, unknown>) {
  const visible = array(snapshot.visible, 2000).map((value) => {
    const tool = object(value)
    return `  ${label(string(tool.id, 256), 40)} · ${string(tool.source, 32)} — ${label(typeof tool.description === "string" ? tool.description : "", 120)}`
  })
  const servers = array(snapshot.mcpServers, 256).map((value) => {
    const server = object(value)
    return `  ${label(string(server.id, 256), 40)} · ${string(server.status, 32)}${typeof server.detail === "string" ? ` — ${label(server.detail, 160)}` : ""}`
  })
  const excluded = array(snapshot.exclusions, 2000).map((value) => {
    const item = object(value)
    const name = [item.id, item.server].find((part) => typeof part === "string") as string | undefined
    return `  ${label(name ?? "tool", 40)} — ${label(string(item.reason, 256), 80)}${typeof item.detail === "string" ? ` (${label(item.detail, 120)})` : ""}`
  })
  return [
    `Agent ${label(typeof snapshot.agent === "string" ? snapshot.agent : "default", 60)} · ${label(typeof snapshot.providerID === "string" ? snapshot.providerID : "", 60)}/${label(typeof snapshot.modelID === "string" ? snapshot.modelID : "", 80)}`,
    "",
    `TOOLS (${visible.length})`,
    ...visible,
    "",
    `MCP SERVERS (${servers.length})`,
    ...(servers.length ? servers : ["  None configured."]),
    "",
    `EXCLUDED (${excluded.length})`,
    ...(excluded.length ? excluded : ["  None."]),
  ].join("\n")
}
