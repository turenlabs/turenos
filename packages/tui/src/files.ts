import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { mentionInReply, openPanel, type Drafts } from "./panel"
import { array, choice, object, optional, string } from "./response-validation"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"

type Entry = { name: string; path: string; type: "file" | "directory"; ignored: boolean }

const MAX_LINES = 5000

/**
 * The desktop's file browser for the selected session's folder on the server: folders open in
 * place, files show read-only on the right, and `@` mentions the chosen file in the reply.
 */
export function createFiles(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  drafts: Drafts,
) {
  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Files")
    if (!panel) return
    panel.dialog.recipient = session
    const directory = session.location.directory
    let folder = ""
    let entries: Entry[] = []
    let request = 0
    const keys = "↑↓ choose · Enter open · ← or Backspace up · PgUp/PgDn scroll · @ mention in reply · Esc close"

    async function list(path: string, select = "") {
      const version = ++request
      try {
        const result = entryList(await connection.api("/file", { directory, query: { path } }))
        if (version !== request || state.modal !== panel!.dialog) return
        folder = path
        entries = result.toSorted(
          (a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name),
        )
        panel!.heading.content = `${label(directory, 120)}/${label(folder, 120)}`
        panel!.list.options = entries.map((entry) => ({
          name: `${entry.type === "directory" ? "▸ " : "  "}${label(entry.name, 120)}${entry.type === "directory" ? "/" : ""}${entry.ignored ? " (ignored)" : ""}`,
          description: "",
        }))
        panel!.list.setSelectedIndex(
          Math.max(
            0,
            entries.findIndex((entry) => entry.path === select),
          ),
        )
        panel!.dialog.error.content = keys
        preview()
      } catch (error) {
        if (version !== request || state.modal !== panel!.dialog) return
        panel!.show(`Could not list ${folder || "this folder"}: ${errorText(error)}`)
      }
    }

    async function preview() {
      const entry = entries[panel!.list.getSelectedIndex()]
      if (!entry) return panel!.show(folder ? "Empty folder." : "No files.")
      if (entry.type === "directory") return panel!.show(`${label(entry.path, 300)}/\n\nEnter opens this folder.`)
      const version = ++request
      panel!.show(`Loading ${label(entry.path, 300)}…`)
      try {
        const file = object(await connection.api("/file/content", { directory, query: { path: entry.path } }))
        if (version !== request || state.modal !== panel!.dialog) return
        choice(file.type, ["text", "binary"])
        optional(file.mimeType, string)
        const text = string(file.content)
        if (file.type === "binary")
          return panel!.show(`Binary file${file.mimeType ? ` (${label(file.mimeType as string, 100)})` : ""}.`)
        const lines = text.split("\n")
        const width = String(Math.min(lines.length, MAX_LINES)).length
        panel!.show(
          [
            ...lines
              .slice(0, MAX_LINES)
              .map(
                (line, index) => `${String(index + 1).padStart(width)}  ${display(line, 2000).replace(/[\r\n]/g, "")}`,
              ),
            ...(lines.length > MAX_LINES ? [`… ${lines.length - MAX_LINES} more lines`] : []),
          ].join("\n") || "Empty file.",
        )
      } catch (error) {
        if (version !== request || state.modal !== panel!.dialog) return
        panel!.show(`Could not read ${label(entry.path, 300)}: ${errorText(error)}`)
      }
    }

    function enter() {
      const entry = entries[panel!.list.getSelectedIndex()]
      if (entry?.type === "directory") return list(entry.path)
    }

    function up() {
      if (!folder) return
      const parent = folder.split("/").slice(0, -1).join("/")
      return list(parent, folder)
    }

    const mentionFile = () =>
      mentionInReply(panel!, dialogs, session!, entries[panel!.list.getSelectedIndex()]?.path, drafts)

    panel.list.on("selectionChanged", () => void preview())
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "enter")
        ? enter
        : matchesKey(key, "left") || matchesKey(key, "backspace")
          ? up
          : key.sequence === "@"
            ? mentionFile
            : undefined
      if (!action) return false
      void action()
      return true
    }
    void list("")
  }

  return { open }
}

function entryList(value: unknown): Entry[] {
  return array(value, 20000).map((item) => {
    const entry = object(item)
    choice(entry.type, ["file", "directory"])
    // The server ends folder paths with a slash; folders are joined and split here without one.
    const path = string(entry.path, 4096).replace(/[\\/]+$/, "")
    // Paths go back to the server as relative queries; an absolute or escaping one is not a listing entry.
    if (!path || path.startsWith("/") || path.split(/[\\/]/).includes(".."))
      throw new Error("Invalid server response (file path).")
    return {
      name: string(entry.name, 1024),
      path,
      type: entry.type as Entry["type"],
      ignored: entry.ignored === true,
    }
  })
}
