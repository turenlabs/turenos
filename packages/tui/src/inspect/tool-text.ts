import { array, object, string } from "../response-validation"
import { label } from "../state"

/** Cuts at a word with an ellipsis; the reader sees one line, never a mid-word break. */
function brief(value: string, limit: number) {
  const text = label(value, 4000).trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2))}…`
}

/** Breaks a row at spaces to `width`, indenting the continuation lines under the row's text. */
function wrap(row: string, width: number) {
  const [first = "", ...rest] = row.trimStart().split(" ")
  const indent = " ".repeat(row.length - row.trimStart().length)
  return rest
    .reduce(
      (lines, word) =>
        lines.at(-1)!.length + 1 + word.length <= width
          ? [...lines.slice(0, -1), `${lines.at(-1)} ${word}`]
          : [...lines, `${indent}    ${word}`],
      [`${indent}${first}`],
    )
    .join("\n")
}

/** Built-in tools come first, then the other sources by name; each group is alphabetical. */
function ordered(tools: Record<string, unknown>[]) {
  const rank = (tool: Record<string, unknown>) => (tool.source === "builtin" ? "" : String(tool.source))
  return tools.toSorted(
    (a, b) => rank(a).localeCompare(rank(b)) || String(a.id).localeCompare(String(b.id)),
  )
}

/** `width` is the columns a row may use; without it, rows are left to the renderer's own wrapping. */
export function toolText(snapshot: Record<string, unknown>, modelNote = "", width = Infinity) {
  const visible = ordered(array(snapshot.visible, 2000).map(object)).map((tool) =>
    wrap(
      `  ${label(string(tool.id, 256), 40)} · ${label(string(tool.source, 32), 32)} — ${brief(typeof tool.description === "string" ? tool.description : "", 100)}`,
      width,
    ),
  )
  const servers = array(snapshot.mcpServers, 256).map((value) => {
    const server = object(value)
    return `  ${label(string(server.id, 256), 40)} · ${label(string(server.status, 32), 32)}${typeof server.detail === "string" ? ` — ${brief(server.detail, 120)}` : ""}`
  })
  const excluded = array(snapshot.exclusions, 2000).map((value) => {
    const item = object(value)
    const name = [item.id, item.server].find((part) => typeof part === "string") as string | undefined
    return `  ${label(name ?? "tool", 40)} — ${brief(string(item.reason, 256), 80)}${typeof item.detail === "string" ? ` (${brief(item.detail, 100)})` : ""}`
  })
  return [
    `Agent ${label(typeof snapshot.agent === "string" ? snapshot.agent : "default", 60)} · ${label(typeof snapshot.providerID === "string" ? snapshot.providerID : "", 60)}/${label(typeof snapshot.modelID === "string" ? snapshot.modelID : "", 80)}${modelNote}`,
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
