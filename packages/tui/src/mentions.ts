import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core"
import { submitMention, mentionKey } from "./mentions/accept"
import { createMentionPopup, type Entry, type Location } from "./mentions/popup"
import type { DashboardState, ModalState } from "./state"
import type { SuggestionPopup } from "./suggest"

export function createMentions(
  renderer: CliRenderer,
  state: Pick<DashboardState, "modal" | "closed">,
  connection: {
    missingFiles?: Set<string>
    findFiles: (
      directory: string,
      query: string,
      workspaceID?: string,
      signal?: AbortSignal,
    ) => Promise<readonly Entry[]>
  },
  onChange: () => void = () => {},
) {
  const env = { renderer, state, connection, onChange }
  let controller: { key: (event: KeyEvent) => boolean } | undefined
  let current: SuggestionPopup<Entry> | undefined

  function attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
    current?.hide()
    const popup = createMentionPopup(env, dialog, editor, location, locked)
    current = popup
    const previousSubmit = dialog.beforeSubmit
    dialog.beforeSubmit = () => submitMention(popup, editor) || (previousSubmit?.() ?? false)
    return { key: (event: KeyEvent) => mentionKey(popup, editor, event) }
  }

  return {
    attach(dialog: ModalState, editor: TextareaRenderable, location: () => Location, locked = () => false) {
      controller = attach(dialog, editor, location, locked)
    },
    key: (event: KeyEvent) => controller?.key(event) ?? false,
  }
}

export type Mentions = ReturnType<typeof createMentions>
