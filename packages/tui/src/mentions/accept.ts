import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { mentionText } from "../prompt-files"
import type { SuggestionPopup } from "../suggest"
import type { Entry } from "./popup"

// A folder keeps the mention open for its next segment; a file closes it and
// leaves a space so prose can continue.
export function acceptMention(popup: SuggestionPopup<Entry>) {
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

export function mentionKey(popup: SuggestionPopup<Entry>, editor: TextareaRenderable, event: KeyEvent) {
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
  return acceptMention(popup)
}
