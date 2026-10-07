import { display } from "../messages"
import type { Panel } from "../panel"
import { choice, object, optional, string } from "../response-validation"
import { errorText, type Connection, type Session } from "../server"
import { label, type DashboardState } from "../state"
import { fitHeading, panelWidth } from "../changes/heading"
import { entryList, type Entry } from "./entries"

const MAX_LINES = 5000

/** Hint parts by priority: the trailing ones drop first when the panel is narrow. Enter acts only on a folder. */
const hints = (entry: Entry | undefined) => [
  "↑↓ choose",
  ...(entry?.type === "directory" ? ["Enter open folder"] : []),
  "←/Backspace up",
  "@ mention in reply",
  "PgUp/PgDn scroll",
  "Ctrl+R refresh",
]

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
  /** Previews count separately so one cannot discard a folder listing, or a listing a preview. */
  preview: number
}

export async function listFolder(b: FileBrowser, path: string, select = "") {
  const { state, connection } = b.ctx
  const version = ++b.request
  try {
    const result = entryList(await connection.api("/file", { directory: b.directory, query: { path } }))
    if (version !== b.request || state.modal !== b.panel.dialog) return
    b.folder = path
    // Folders first, and the repository's own `.git` last of all: it is rarely what the reader came for.
    b.entries = result.toSorted(
      (left, right) =>
        Number(left.name === ".git") - Number(right.name === ".git") ||
        Number(right.type === "directory") - Number(left.type === "directory") ||
        left.name.localeCompare(right.name),
    )
    b.panel.fit("heading", () => (b.panel.heading.content = fitPath(b)))
    // The trailing slash marks a folder, so the selection arrow is the only leading glyph.
    b.panel.list.options = b.entries.map((entry) => ({
      name: `${label(entry.name, 120)}${entry.type === "directory" ? "/" : ""}${entry.ignored ? " (ignored)" : ""}`,
      description: "",
    }))
    b.panel.list.setSelectedIndex(
      Math.max(
        0,
        b.entries.findIndex((entry) => entry.path === select),
      ),
    )
    void preview(b)
  } catch (error) {
    if (version !== b.request || state.modal !== b.panel.dialog) return
    b.panel.show(`Could not list ${path ? label(path, 300) : "this folder"}: ${errorText(error)}`)
  }
}

/** The folder's path, cut from the left so the folder being browsed stays visible. */
function fitPath(b: FileBrowser) {
  return fitHeading(panelWidth(b.panel), "", `${label(b.directory, 400)}/${label(b.folder, 400)}`, "", "start")
}

export async function preview(b: FileBrowser) {
  const { state, connection } = b.ctx
  // Counted before the early returns, so a file preview still in flight cannot overwrite them.
  const version = ++b.preview
  const entry = b.entries[b.panel.list.getSelectedIndex()]
  b.panel.hints(hints(entry), ["Esc close"])
  if (!entry) return b.panel.show(b.folder ? "Empty folder." : "No files.")
  if (entry.type === "directory") return b.panel.show(`${label(entry.path, 300)}/\n\nEnter opens this folder.`)
  const title = label(entry.path, 300)
  b.panel.show(`Loading ${title}…`)
  try {
    const file = object(await connection.api("/file/content", { directory: b.directory, query: { path: entry.path } }))
    if (version !== b.preview || state.modal !== b.panel.dialog) return
    choice(file.type, ["text", "binary"])
    optional(file.mimeType, string)
    if (file.type === "binary")
      return b.panel.show(`${title}\n\nBinary file${file.mimeType ? ` (${label(file.mimeType as string, 100)})` : ""}.`)
    b.panel.show(`${title}\n\n${numbered(string(file.content))}`)
  } catch (error) {
    if (version !== b.preview || state.modal !== b.panel.dialog) return
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

/** Lists the open folder again and keeps the selected entry. */
export function refresh(b: FileBrowser) {
  return listFolder(b, b.folder, b.entries[b.panel.list.getSelectedIndex()]?.path)
}

export function up(b: FileBrowser) {
  if (!b.folder) return
  const parent = b.folder.split("/").slice(0, -1).join("/")
  return listFolder(b, parent, b.folder)
}
