import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { mentionText } from "./prompt-files"
import type { DashboardState, ModalState } from "./state"
import { createSuggestionPopup } from "./suggest"

type Entry = { path: string; type: "file" | "directory" }
type Location = { directory: string; workspaceID?: string }

// The quoted alternative is deliberately unterminated: it matches while the
// caret is still inside `@"…`, so a path with spaces or brackets keeps searching.
const active = /(?:^|[\s([{"'])@(?:"([^"\u0000-\u001f\u007f-\u009f]*)|([^\s()[\]{}"'`]*))$/

export function createMentions(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  connection: {
    findFiles: (
      directory: string,
      query: string,
      workspaceID?: string,
      signal?: AbortSignal,
    ) => Promise<readonly Entry[]>
  },
  onChange: () => void = () => {},
) {
  let controller: { key: (event: KeyEvent) => boolean } | undefined
  let current: ReturnType<typeof createSuggestionPopup<Entry>> | undefined

  function attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
    current?.hide()
    const popup = createSuggestionPopup<Entry>(renderer, state, {
      id: `${editor.id}-mentions`,
      dialog,
      editor,
      locked,
      rows: (count) => {
        dialog.mentionRows = count
        onChange()
      },
      match(text, cursor) {
        const prefix = active.exec(text.slice(0, cursor))
        if (!prefix) return undefined
        const quoted = prefix[1] !== undefined
        const query = quoted ? prefix[1]! : prefix[2]!
        // A bare `#` range addresses an already-chosen file. Inside quotes it is
        // part of the name, so only the bare form stops searching.
        if (!quoted && query.includes("#")) return undefined
        return { query, start: cursor - query.length - (quoted ? 2 : 1), end: cursor }
      },
      scope: (query) => JSON.stringify([location().directory, location().workspaceID, query]),
      load: (query, signal) => connection.findFiles(location().directory, query, location().workspaceID, signal),
      // Recursive search is expensive; match the session finder's typing pause.
      debounce: 250,
      // A path this grammar cannot represent is never offered, so completing a
      // result can never insert text that parses back to a different file.
      filter: (items) => items.filter((item) => mentionText(item.path)).slice(0, 50),
      line: (item) => `${display(item.path, 200).replace(/\s/g, " ")}${item.type === "directory" ? "/" : ""}`,
      messages: {
        loading: "Searching files…",
        error: "File search unavailable. Keep typing a path.",
        empty: "No matching files.",
      },
    })
    current = popup

    // A folder keeps the mention open for its next segment; a file closes it and
    // leaves a space so prose can continue.
    function accept() {
      const chosen = popup.current
      if (!chosen) return false
      const folder = chosen.type === "directory"
      const text = mentionText(folder ? `${chosen.path}/` : chosen.path)
      if (!text) return false
      const inserted = folder ? text : `${text} `
      // Keep the caret inside a quoted folder so its next segment keeps searching.
      popup.replace(inserted, folder && text.endsWith('"') ? inserted.length - 1 : inserted.length)
      if (folder) popup.refresh()
      else popup.dismiss()
      return true
    }

    const previousSubmit = dialog.beforeSubmit
    dialog.beforeSubmit = () => {
      if (popup.usable() && popup.visible && popup.status === "ready" && popup.choices.length) return accept()
      return previousSubmit?.() ?? false
    }

    return {
      key(event: KeyEvent) {
        if (!popup.usable()) {
          popup.hide()
          return false
        }
        if (!editor.focused) return false
        popup.refresh()
        if (!popup.visible) return false
        if (matchesKey(event, "escape")) {
          event.preventDefault()
          popup.dismiss()
          return true
        }
        const enter = matchesKey(event, "enter")
        const tab = matchesKey(event, "tab")
        if (!enter && !tab && !matchesKey(event, "up") && !matchesKey(event, "down")) return false
        // Never send a half-typed path while discovery is pending.
        if (popup.status === "loading") {
          if (!enter && !tab) return false
          event.preventDefault()
          return true
        }
        if (popup.status !== "ready" || !popup.choices.length) return false
        if (popup.move(event)) return true
        event.preventDefault()
        return accept()
      },
    }
  }

  return {
    attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
      controller = attach(dialog, editor, location, locked)
    },
    key: (event: KeyEvent) => controller?.key(event) ?? false,
  }
}

export type Mentions = ReturnType<typeof createMentions>
