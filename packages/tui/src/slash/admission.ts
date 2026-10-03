import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import type { ModalState } from "../state"
import type { SuggestionPopup } from "../suggest"
import type { Choice } from "./commands"

export type SlashAttachment = {
  popup: SuggestionPopup<Choice>
  dialog: ModalState
  editor: TextareaRenderable
  runLocal: (name: string, dialog: ModalState, editor: TextareaRenderable) => void
}

function complete(attachment: SlashAttachment, chosen: Choice) {
  attachment.popup.replace(`/${chosen.name} `, chosen.name.length + 2)
  attachment.popup.refresh()
}

// Mouse Send and modified submit keys must admit local actions exactly as
// Enter does, so submission routes through here rather than the key handler.
export function submitSlash(attachment: SlashAttachment) {
  const popup = attachment.popup
  if (!popup.usable()) return false
  popup.refresh()
  if (!popup.visible) return false
  if (popup.status === "loading") return true
  if (popup.status !== "ready" || !popup.choices.length) return false
  const exact = popup.choices.find((item) => item.name === popup.query)
  if (exact && !exact.local) return false
  if (exact) attachment.runLocal(exact.name, attachment.dialog, attachment.editor)
  else complete(attachment, popup.current!)
  return true
}

export function slashKey(attachment: SlashAttachment, event: KeyEvent) {
  const popup = attachment.popup
  if (!popup.usable()) {
    popup.hide()
    return false
  }
  if (!attachment.editor.focused) return false
  popup.refresh()
  if (!popup.visible) return false
  const enter = matchesKey(event, "enter")
  const tab = matchesKey(event, "tab")
  if (!enter && !tab && !matchesKey(event, "up") && !matchesKey(event, "down")) return false
  // Do not send a partial command or run a colliding local action while
  // discovery is pending.
  if (popup.status === "loading") {
    if (!enter && !tab) return false
    event.preventDefault()
    return true
  }
  if (popup.status !== "ready" || !popup.choices.length) return false
  if (enter) return submitSlash(attachment)
  if (popup.move(event)) return true
  event.preventDefault()
  complete(attachment, popup.current!)
  return true
}
