import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core"
import type { DashboardState, ModalState } from "./state"
import { slashKey, submitSlash } from "./slash/admission"
import type { Choice, Command } from "./slash/commands"
import { createSlashPopup, type Location } from "./slash/popup"
import type { SuggestionPopup } from "./suggest"

export function createSlashCommands(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  connection: { commands: (directory: string, workspaceID?: string) => Promise<readonly Command[]> },
  localCommands: () => { name: string; description: string; run: () => void }[],
  runLocal: (name: string, dialog: ModalState, editor: TextareaRenderable) => void,
  onChange: () => void = () => {},
) {
  const env = { renderer, state, connection, localCommands, runLocal, onChange }
  let controller: { key: (event: KeyEvent) => boolean } | undefined
  let current: SuggestionPopup<Choice> | undefined

  function attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
    current?.hide()
    const popup = createSlashPopup(env, dialog, editor, location, locked)
    current = popup
    const attachment = { popup, dialog, editor, runLocal }
    // Chain rather than assign: several controllers attach to the same editor
    // and none of them may depend on attach order.
    const previousSubmit = dialog.beforeSubmit
    dialog.beforeSubmit = () => submitSlash(attachment) || (previousSubmit?.() ?? false)
    return { key: (event: KeyEvent) => slashKey(attachment, event) }
  }

  return {
    attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
      controller = attach(dialog, editor, location, locked)
    },
    key: (event: KeyEvent) => controller?.key(event) ?? false,
  }
}

export type SlashCommands = ReturnType<typeof createSlashCommands>
