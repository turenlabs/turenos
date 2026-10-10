import type { Dialogs } from "../dialogs"
import type { ModalState } from "../state"
import { followText } from "../suggest/editor-height"

/** The editor docked under the detail pane: one row for a short message, growing with the text up to six. */
export function dockedEditor(
  dialogs: Pick<Dialogs, "prompt" | "resize">,
  dialog: ModalState,
  text: string,
  cursor: number | undefined,
  locked: () => boolean,
  placeholder?: string,
) {
  const editor = dialogs.prompt(dialog, "Your message", text, cursor, true)
  dialog.editor = editor
  dialog.editorLocked = locked
  editor.marginBottom = 0
  if (placeholder) editor.placeholder = placeholder
  followText(editor, 1, 6, dialogs.resize)
  return editor
}
