import type { KeyEvent } from "@opentui/core"
import { matchesKey } from "../keys"
import type { PopupState } from "./popup-state"

// A superseded query is aborted, not merely ignored, so a fast typist cannot
// leave recursive server searches running to completion.
export function cancelPending<T>(popup: PopupState<T>) {
  clearTimeout(popup.timer)
  popup.timer = undefined
  popup.pending?.abort()
  popup.pending = undefined
  popup.afterLoad = undefined
}

export function show<T>(popup: PopupState<T>, count: number) {
  popup.suggestions.visible = count > 0
  popup.suggestions.height = Math.max(1, count)
  if (popup.rows === count) return
  popup.rows = count
  popup.options.rows(count)
}

export function usable<T>(popup: PopupState<T>) {
  return (
    !popup.app.closed &&
    popup.app.modal === popup.options.dialog &&
    !popup.options.dialog.busy &&
    !popup.options.locked() &&
    !popup.options.editor.isDestroyed &&
    !popup.suggestions.isDestroyed
  )
}

export function hide<T>(popup: PopupState<T>) {
  popup.generation++
  cancelPending(popup)
  if (popup.status === "loading") popup.status = "idle"
  if (!popup.suggestions.isDestroyed) show(popup, 0)
}

/** Closes the list until the text changes, keeping the loaded inventory. */
export function close<T>(popup: PopupState<T>) {
  popup.dismissed = popup.options.editor.plainText
  show(popup, 0)
}

export function dismiss<T>(popup: PopupState<T>) {
  popup.dismissed = popup.options.editor.plainText
  popup.generation++
  cancelPending(popup)
  popup.status = "idle"
  show(popup, 0)
}

export function paint<T>(popup: PopupState<T>) {
  const size = popup.options.window?.() ?? 3
  const start = Math.max(0, popup.selected - size + 1)
  // The list is never wrapped, so each row is fitted to the editor's width, which is the dialog's text width.
  const width = popup.options.editor.width > 4 ? popup.options.editor.width - 2 : Infinity
  const lines = popup.choices.slice(start, start + size).map((item, index) => {
    return `${start + index === popup.selected ? "▶" : " "} ${clip(popup.options.line(item, width), width)}`
  })
  if (popup.choices.length > size) lines.push(`  ${popup.selected + 1} of ${popup.choices.length}`)
  popup.suggestions.content = lines.join("\n")
  show(popup, lines.length)
}

function clip(text: string, width: number) {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function move<T>(popup: PopupState<T>, event: KeyEvent) {
  const up = matchesKey(event, "up")
  if (!up && !matchesKey(event, "down")) return false
  event.preventDefault()
  popup.selected = (popup.selected + (up ? -1 : 1) + popup.choices.length) % popup.choices.length
  paint(popup)
  return true
}

export function replace<T>(popup: PopupState<T>, text: string, cursor: number) {
  const editor = popup.options.editor
  editor.setText(editor.plainText.slice(0, popup.trigger.start) + text + editor.plainText.slice(popup.trigger.end))
  editor.cursorOffset = popup.trigger.start + cursor
}
