import type { CliRenderer, TextareaRenderable } from "@opentui/core"
import { display } from "../messages"
import { mentionText, recordSearch } from "../prompt-files"
import type { DashboardState, ModalState } from "../state"
import { createSuggestionPopup } from "../suggest"

export type Entry = { path: string; type: "file" | "directory" }
export type Location = { directory: string; workspaceID?: string }

export type MentionEnvironment = {
  renderer: CliRenderer
  state: Pick<DashboardState, "modal" | "closed">
  connection: {
    missingFiles?: Set<string>
    findFiles: (
      directory: string,
      query: string,
      workspaceID?: string,
      signal?: AbortSignal,
    ) => Promise<readonly Entry[]>
  }
  onChange: () => void
}

// The quoted alternative is deliberately unterminated: it matches while the
// caret is still inside `@"…`, so a path with spaces or brackets keeps searching.
export const active = /(?:^|[\s([{"'])@(?:"([^"\u0000-\u001f\u007f-\u009f]*)|([^\s()[\]{}"'`]*))$/

/** A single character is not searched; the list asks for more instead. */
const minQuery = 2

export function createMentionPopup(
  env: MentionEnvironment,
  dialog: ModalState,
  editor: TextareaRenderable,
  location: () => Location,
  locked: () => boolean,
) {
  return createSuggestionPopup<Entry>(env.renderer, env.state, {
    id: `${editor.id}-mentions`,
    dialog,
    editor,
    locked,
    rows: (count) => {
      dialog.mentionRows = count
      dialog.refresh?.()
      env.onChange()
    },
    match(text, cursor) {
      const prefix = active.exec(text.slice(0, cursor))
      if (!prefix) return undefined
      const quoted = prefix[1] !== undefined
      const query = quoted ? prefix[1]! : prefix[2]!
      // A bare `#` range addresses an already-chosen file. Inside quotes it is
      // part of the name, so only the bare form stops searching.
      if (!quoted && query.includes("#")) return undefined
      // Folder completion leaves the caret before this quote; replace it with
      // the completed path's quote rather than retaining a second one.
      const end = quoted && text[cursor] === '"' ? cursor + 1 : cursor
      return { query, start: cursor - query.length - (quoted ? 2 : 1), end }
    },
    scope: (query) => JSON.stringify([location().directory, location().workspaceID, query]),
    async load(query, signal) {
      // Too short a query is not a search: the popup says how much to type instead of reporting a failure.
      if (query.length < minQuery) return []
      const where = location()
      const found = await env.connection.findFiles(where.directory, query, where.workspaceID, signal)
      if (!signal.aborted && env.connection.missingFiles)
        recordSearch(env.connection.missingFiles, where, query, found.length > 0)
      return found
    },
    // Recursive search is expensive; match the session finder's typing pause.
    debounce: 250,
    // A path this grammar cannot represent is never offered, so completing a
    // result can never insert text that parses back to a different file.
    filter: (items) => items.filter((item) => mentionText(item.path)).slice(0, 50),
    line: (item) => `${display(item.path, 200).replace(/\s/g, " ")}${item.type === "directory" ? "/" : ""}`,
    messages: {
      loading: "Searching files…",
      error: "File search unavailable. Keep typing a path.",
      empty: (query) =>
        !query
          ? "Type a file name or path to search."
          : query.length < minQuery
            ? `Type ${minQuery} or more characters to search files`
            : "No matching files. The mention stays as text.",
    },
  })
}
