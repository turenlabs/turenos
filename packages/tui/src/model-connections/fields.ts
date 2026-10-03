import { TextRenderable } from "@opentui/core"
import { secretField } from "../secret-field"
import type { ModalState } from "../state"
import { color } from "../theme"
import type { Flow } from "./flow"

export function secret(flow: Flow, dialog: ModalState, title: string, limit = 8192, placeholder = "") {
  dialog.form.add(new TextRenderable(flow.renderer, { content: title, fg: color.muted }))
  const { field, take } = secretField(flow.renderer, {
    limit,
    placeholder,
    reject: () => {
      dialog.error.content = `Input rejected: at most ${limit} characters; no control characters. Ctrl+U clears.`
      dialog.error.fg = color.error
    },
  })
  dialog.form.add(field)
  flow.dialogs.track(dialog, field)
  field.focus()
  return take
}

export function credential(dialog: ModalState, value: string) {
  if (value.trim() && value === value.trim()) return true
  dialog.error.content = "Enter a credential without surrounding whitespace. The hidden field was cleared."
  dialog.error.fg = color.error
  return false
}
