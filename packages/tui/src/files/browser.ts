import { display } from "../messages"
import type { Panel } from "../panel"
import { choice, object, optional, string } from "../response-validation"
import { errorText, type Connection, type Session } from "../server"
import { label, type DashboardState } from "../state"
import { entryList, type Entry } from "./entries"

const MAX_LINES = 5000

export const KEYS = "↑↓ choose · Enter open · ← or Backspace up · PgUp/PgDn scroll · @ mention in reply · Esc close"

export type FilesContext = { state: DashboardState; connection: Connection }

/** One open Files panel: the folder shown, its entries, and the latest request that may still paint. */
export type FileBrowser = {
  ctx: FilesContext
  session: Session
  directory: string
  panel: Panel
  folder: string
  entries: Entry[]
  request: number
}

export async function listFolder(b: FileBrowser, path: string, select = "") {
  const { state, connection } = b.ctx
  const version = ++b.request
  try {
    const result = entryList(await connection.api("/file", { directory: b.directory, query: { path } }))
    if (version !== b.request || state.modal !== b.panel.dialog) return
    b.folder = path
    b.entries = result.toSorted(
      (left, right) =>
        Number(right.type === "directory") - Number(left.type === "directory") || left.name.localeCompare(right.name),
    )
    b.panel.heading.content = `${label(b.directory, 120)}/${label(b.folder, 120)}`
    b.panel.list.options = b.entries.map((entry) => ({
      name: `${entry.type === "directory" ? "▸ " : "  "}${label(entry.name, 120)}${entry.type === "directory" ? "/" : ""}${entry.ignored ? " (ignored)" : ""}`,
      description: "",
    }))
    b.panel.list.setSelectedIndex(
      Math.max(
        0,
        b.entries.findIndex((entry) => entry.path === select),
      ),
    )
    b.panel.dialog.error.content = KEYS
    void preview(b)
  } catch (error) {
    if (version !== b.request || state.modal !== b.panel.dialog) return
    b.panel.show(`Could not list ${b.folder || "this folder"}: ${errorText(error)}`)
  }
}

export async function preview(b: FileBrowser) {
  const { state, connection } = b.ctx
  const entry = b.entries[b.panel.list.getSelectedIndex()]
  if (!entry) return b.panel.show(b.folder ? "Empty folder." : "No files.")
  if (entry.type === "directory") return b.panel.show(`${label(entry.path, 300)}/\n\nEnter opens this folder.`)
  const version = ++b.request
  b.panel.show(`Loading ${label(entry.path, 300)}…`)
  try {
    const file = object(await connection.api("/file/content", { directory: b.directory, query: { path: entry.path } }))
    if (version !== b.request || state.modal !== b.panel.dialog) return
    choice(file.type, ["text", "binary"])
    optional(file.mimeType, string)
    const text = string(file.content)
    if (file.type === "binary")
      return b.panel.show(`Binary file${file.mimeType ? ` (${label(file.mimeType as string, 100)})` : ""}.`)
    b.panel.show(numbered(text))
  } catch (error) {
    if (version !== b.request || state.modal !== b.panel.dialog) return
    b.panel.show(`Could not read ${label(entry.path, 300)}: ${errorText(error)}`)
  }
}

/** The file's lines with a right-aligned number gutter, capped at MAX_LINES. */
function numbered(text: string) {
  const lines = text.split("\n")
  const width = String(Math.min(lines.length, MAX_LINES)).length
  return (
    [
      ...lines
        .slice(0, MAX_LINES)
        .map((line, index) => `${String(index + 1).padStart(width)}  ${display(line, 2000).replace(/[\r\n]/g, "")}`),
      ...(lines.length > MAX_LINES ? [`… ${lines.length - MAX_LINES} more lines`] : []),
    ].join("\n") || "Empty file."
  )
}

export function enter(b: FileBrowser) {
  const entry = b.entries[b.panel.list.getSelectedIndex()]
  if (entry?.type === "directory") return listFolder(b, entry.path)
}

export function up(b: FileBrowser) {
  if (!b.folder) return
  const parent = b.folder.split("/").slice(0, -1).join("/")
  return listFolder(b, parent, b.folder)
}
