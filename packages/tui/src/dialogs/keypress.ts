import { InputRenderable, TextareaRenderable, type KeyEvent } from "@opentui/core"
import { display } from "../messages"
import { matchesKey } from "../keys"
import type { ModalState } from "../state"
import type { DialogContext } from "./context"
import { compose } from "./compose"
import { reveal } from "./fields"
import { close } from "./lifecycle"
import { submit } from "./submit"

export function keypress(ctx: DialogContext, key: KeyEvent) {
  const current = ctx.state.modal
  if (!current) return false
  // Native bindings do not distinguish Hyper; do not let it fall through as an unmodified key.
  if (current.busy || key.hyper || key.eventType === "release") {
    key.preventDefault()
    return true
  }
  // Gated on a focused prompt editor so the pickers keep their own F2. Ctrl+G is Claude Code's and Codex's binding.
  if ((matchesKey(key, "f2") || matchesKey(key, "g", { ctrl: true })) && current.editor?.focused) {
    key.preventDefault()
    void compose(ctx)
    return true
  }
  if (matchesKey(key, "escape")) {
    key.preventDefault()
    close(ctx)
    current.back?.()
    return true
  }
  if (recallPrevious(ctx, current, key)) return true
  if (matchesKey(key, "f4") && current.discard) {
    key.preventDefault()
    current.discard()
    close(ctx, false)
    ctx.hooks.changed(true)
    ctx.hooks.say("Local draft discarded. Server work continues.")
    return true
  }
  if (matchesKey(key, "pageup") || matchesKey(key, "pagedown")) return scrollPage(ctx, current, key)
  if (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true })) return cycleFocus(ctx, current, key)
  return routeSubmitKeys(ctx, current, key)
}

function recallPrevious(ctx: DialogContext, current: ModalState, key: KeyEvent) {
  if (!current.editor?.focused || current.editor.plainText || !matchesKey(key, "up")) return false
  const previous = ctx.hooks.recall?.()
  if (!previous) return false
  key.preventDefault()
  if (previous.length > 32000)
    ctx.hooks.say("Previous prompt is too long for this editor. Copy the needed text from History.")
  else current.editor.setText(display(previous, 32000))
  return true
}

function scrollPage(ctx: DialogContext, current: ModalState, key: KeyEvent) {
  key.preventDefault()
  if (current.key?.(key)) return true
  if (current.docked) ctx.hooks.cancelPosition()
  const target = current.docked && current.editor ? ctx.ui.detail : current.form
  target.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, target.viewport.height - 1))
  return true
}

function cycleFocus(ctx: DialogContext, current: ModalState, key: KeyEvent) {
  key.preventDefault()
  if (!current.fields.length) {
    current.form.focus()
    ctx.renderer.setCursorPosition(0, 0, false)
    return true
  }
  current.settings?.()
  current.index = (current.index + (key.shift ? -1 : 1) + current.fields.length) % current.fields.length
  const focusedField = current.fields[current.index]
  focusedField?.focus()
  if (!(focusedField instanceof InputRenderable) && !(focusedField instanceof TextareaRenderable)) {
    ctx.renderer.setCursorPosition(0, 0, false)
  }
  if (focusedField) reveal(current, focusedField)
  return true
}

function routeSubmitKeys(ctx: DialogContext, current: ModalState, key: KeyEvent) {
  if (current.editor?.focused && matchesKey(key, "enter")) {
    key.preventDefault()
    void submit(ctx)
    return true
  }
  if (
    current.editor?.focused &&
    (matchesKey(key, "enter", { shift: true }) || matchesKey(key, "enter", { meta: true }))
  ) {
    key.preventDefault()
    current.editor.insertText("\n")
    return true
  }
  if (matchesKey(key, "enter", { ctrl: true }) || matchesKey(key, "s", { ctrl: true })) {
    key.preventDefault()
    void submit(ctx)
    return true
  }
  if (current.key?.(key)) key.preventDefault()
  return true
}
