import { TextRenderable } from "@opentui/core"
import { markFocus } from "../automations/focus"
import { clearOnEdit } from "../dialogs/fields"
import type { ModalState } from "../state"
import { color } from "../theme"
import type { TeamContext } from "./types"

/**
 * A multi-line field in a form: a caption, then the shared reply editor widget. Enter adds a line and Ctrl+S
 * submits, so the dialog does not treat this editor as a message box (`dialog.editor` stays unset).
 */
export function textArea(ctx: TeamContext, dialog: ModalState, caption: string, value = "", height = 4, placeholder = "") {
  dialog.form.add(new TextRenderable(ctx.renderer, { content: caption, fg: color.muted }))
  const field = ctx.dialogs.prompt(dialog, caption, value, value.length, true)
  dialog.editor = undefined
  field.height = height
  field.minHeight = Math.min(3, height)
  field.marginBottom = 0
  field.placeholder = placeholder
  clearOnEdit(dialog, field)
  markFocus(field)
  return field
}
