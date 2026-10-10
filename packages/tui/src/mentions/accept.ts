import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { mentionText } from "../prompt-files"
import type { SuggestionPopup } from "../suggest"
import type { Entry } from "./popup"

// A folder keeps the mention open for its next segment; a file closes it and
// leaves a space so prose can continue.
function acceptMention(popup: SuggestionPopup<Entry>, editor: TextareaRenderable) {
  const chosen = popup.current
  if (!chosen) return false
  const folder = chosen.type === "directory"
  const text = mentionText(folder ? `${chosen.path}/` : chosen.path)
  if (!text) return false
  // Replacing a quoted path consumes its closing quote. Keep a following range
  // attached, and retain any existing whitespace before the remaining prose.
  const suffix = editor.plainText.slice(editor.cursorOffset).replace(/^"/, "")
  const inserted = folder || /^[#\s]/.test(suffix) ? text : `${text} `
  // Keep the caret inside a quoted folder so its next segment keeps searching.
  popup.replace(inserted, folder && text.endsWith('"') ? inserted.length - 1 : inserted.length)
  if (folder) popup.refresh()
  else popup.dismiss()
  return true
}

/** All submission routes keep an unfinished search out of the outgoing prompt. */
export function submitMention(popup: SuggestionPopup<Entry>, editor: TextareaRenderable) {
  if (!popup.usable()) return false
  popup.refresh()
  if (!popup.visible) return false
  if (popup.status === "loading") return true
  if (popup.status !== "ready" || !popup.choices.length) return false
  return acceptMention(popup, editor)
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
  if (enter || tab) {
    const consumed = submitMention(popup, editor)
    if (consumed) event.preventDefault()
    return consumed
  }
  if (popup.status !== "ready" || !popup.choices.length) return false
  return popup.move(event)
}
