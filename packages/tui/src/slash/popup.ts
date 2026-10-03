import type { CliRenderer, TextareaRenderable } from "@opentui/core"
import type { DashboardState, ModalState } from "../state"
import { createSuggestionPopup } from "../suggest"
import {
  describe,
  matchSlash,
  mergeLocal,
  validInventory,
  type Choice,
  type Command,
  type LocalCommand,
} from "./commands"

export type Location = { directory: string; workspaceID?: string }

export type SlashEnvironment = {
  renderer: CliRenderer
  state: Pick<DashboardState, "modal" | "closed">
  connection: { commands: (directory: string, workspaceID?: string) => Promise<readonly Command[]> }
  localCommands: () => LocalCommand[]
  runLocal: (name: string, dialog: ModalState, editor: TextareaRenderable) => void
  onChange: () => void
}

export function createSlashPopup(
  env: SlashEnvironment,
  dialog: ModalState,
  editor: TextareaRenderable,
  location: () => Location,
  locked: () => boolean,
) {
  return createSuggestionPopup<Choice>(env.renderer, env.state, {
    id: `${editor.id}-slash`,
    dialog,
    editor,
    locked,
    rows: (count) => {
      dialog.suggestionRows = count
      env.onChange()
    },
    match: matchSlash,
    scope: () => JSON.stringify([location().directory, location().workspaceID]),
    async load() {
      return validInventory(await env.connection.commands(location().directory, location().workspaceID))
    },
    filter: (items, query) => mergeLocal(items, env.localCommands(), query),
    line: describe,
    messages: {
      loading: "Loading commands...",
      error: "Commands unavailable. Retype / to retry; your draft is kept.",
    },
  })
}
