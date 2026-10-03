import { cancelPending, hide, paint, show, usable } from "./popup-ops"
import type { PopupState } from "./popup-state"

export function refresh<T>(popup: PopupState<T>) {
  if (!usable(popup)) return hide(popup)
  const options = popup.options
  const next = options.match(options.editor.plainText, options.editor.cursorOffset)
  if (!next) {
    show(popup, 0)
    if (popup.status !== "ready") {
      popup.generation++
      popup.status = "idle"
    }
    return
  }
  popup.trigger = next
  if (popup.query !== next.query) popup.selected = 0
  popup.query = next.query
  const nextScope = options.scope(popup.query)
  if (nextScope !== popup.scope) {
    popup.scope = nextScope
    popup.generation++
    cancelPending(popup)
    popup.status = "idle"
    popup.inventory = []
  }
  if (popup.status === "idle") startLoad(popup)
  if (popup.status !== "ready") {
    popup.choices = []
    popup.suggestions.content = popup.status === "error" ? options.messages.error : options.messages.loading
    show(popup, 1)
    return
  }
  popup.choices = options.filter(popup.inventory, popup.query)
  if (!popup.choices.length && options.messages.empty) {
    popup.suggestions.content = options.messages.empty
    show(popup, 1)
    return
  }
  popup.selected = Math.min(popup.selected, Math.max(0, popup.choices.length - 1))
  paint(popup)
}

function startLoad<T>(popup: PopupState<T>) {
  popup.status = "loading"
  const request = ++popup.generation
  cancelPending(popup)
  const controller = (popup.pending = new AbortController())
  const start = () =>
    void Promise.resolve()
      .then(() => popup.options.load(popup.query, controller.signal))
      .then((items) => {
        if (request !== popup.generation) return
        if (!usable(popup)) return hide(popup)
        if (popup.options.scope(popup.query) !== popup.scope) return refresh(popup)
        popup.inventory = items
        popup.status = "ready"
        refresh(popup)
      })
      .catch(() => {
        if (request !== popup.generation) return
        if (!usable(popup)) return hide(popup)
        popup.status = "error"
        refresh(popup)
      })
  if (popup.options.debounce) popup.timer = setTimeout(start, popup.options.debounce)
  else start()
}
