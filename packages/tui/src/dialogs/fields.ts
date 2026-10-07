import { InputRenderable, TextareaRenderable, TextRenderable, TextAttributes, fg, t } from "@opentui/core"
import { color } from "../theme"
import type { Field, ModalState } from "../state"
import type { DialogContext } from "./context"
import { submit } from "./submit"

export function input(ctx: DialogContext, dialog: ModalState, label: string, value = "", placeholder = "") {
  const caption = new TextRenderable(ctx.renderer, { content: label, fg: color.muted })
  dialog.form.add(caption)
  const field = new InputRenderable(ctx.renderer, {
    value,
    placeholder,
    maxLength: 4096,
    backgroundColor: color.bg,
    textColor: color.text,
    focusedBackgroundColor: color.selected,
    placeholderColor: color.muted,
    marginBottom: 1,
  })
  dialog.form.add(field)
  caption.onMouseDown = (event) => {
    event.preventDefault()
    field.focus()
  }
  track(ctx, dialog, field)
  clearStaleError(ctx, dialog, field)
  return field
}

const hints = new WeakMap<ModalState, { content: string; height: TextRenderable["height"] }>()

/** The text a TextRenderable shows, whatever way its content was set. */
function plain(text: TextRenderable) {
  return text.content.chunks.map((chunk) => chunk.text).join("")
}

/** The message the shared submit path shows after a failed attempt. */
function failed(text: TextRenderable) {
  return plain(text).includes("Ctrl+S retry")
}

/** Editing a field drops a failure message and brings back the hint the dialog started with. */
function clearStaleError(ctx: DialogContext, dialog: ModalState, field: InputRenderable) {
  const remember = () => {
    if (!hints.has(dialog) && !failed(dialog.error))
      hints.set(dialog, { content: plain(dialog.error), height: dialog.error.height })
  }
  field.on("focused", remember)
  field.on("input", () => {
    remember()
    const hint = hints.get(dialog)
    if (!hint || !failed(dialog.error)) return
    dialog.error.content = hint.content
    dialog.error.height = hint.height
    dialog.error.fg = color.muted
    ctx.ui.resize()
  })
}

/**
 * Blocks submitting until the field holds `word`. The mismatch shows above the dialog's own hint,
 * so the footer keeps its verb, and clears as soon as the text changes.
 */
export function requireWord(dialog: ModalState, field: InputRenderable, word: string, resize: () => void) {
  const mismatch = `! Type ${word} to confirm.`
  let hint = ""
  field.on("input", () => {
    if (!plain(dialog.error).startsWith(mismatch)) return
    dialog.error.content = hint
    resize()
  })
  const previous = dialog.beforeSubmit
  dialog.beforeSubmit = () => {
    if (field.value.trim() === word) return previous?.() ?? false
    if (!plain(dialog.error).startsWith(mismatch)) hint = plain(dialog.error)
    dialog.error.content = t`${fg(color.error)(mismatch)}\n${fg(color.muted)(hint)}`
    resize()
    return true
  }
}

/** `bare` leaves out the caption and the Send button, for the reply editor that stays docked while typing. */
export function prompt(
  ctx: DialogContext,
  dialog: ModalState,
  label: string,
  value = "",
  cursor = value.length,
  bare = false,
) {
  const caption = new TextRenderable(ctx.renderer, { content: label, fg: color.text, attributes: TextAttributes.BOLD })
  if (!bare) dialog.form.add(caption)
  const field = new TextareaRenderable(ctx.renderer, {
    height: 6,
    minHeight: 3,
    backgroundColor: color.bg,
    textColor: color.text,
    focusedBackgroundColor: color.selected,
    wrapMode: "word",
    placeholder: "Type a message… / commands · @ files · ! shell",
    placeholderColor: color.muted,
    marginBottom: 1,
    initialValue: value,
  })
  field.onContentChange = () => {
    if (field.plainText.length <= 32000) return
    const kept = field.plainText.slice(0, 32000)
    // A cut inside a surrogate pair would leave a lone high surrogate, which JSON bodies reject.
    field.setText(/[\ud800-\udbff]$/.test(kept) ? kept.slice(0, -1) : kept)
    dialog.error.content = "Task is limited to 32,000 characters."
  }
  dialog.form.add(field)
  field.cursorOffset = Math.max(0, Math.min(cursor, value.length))
  dialog.editor = field
  if (!bare) addSendButton(ctx, dialog)
  caption.onMouseDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    field.focus()
  }
  track(ctx, dialog, field)
  return field
}

function addSendButton(ctx: DialogContext, dialog: ModalState) {
  const send = new TextRenderable(ctx.renderer, {
    content: "[ Send (Enter) ]",
    height: 1,
    width: 16,
    flexShrink: 0,
    fg: color.bg,
    bg: color.accent,
    attributes: TextAttributes.BOLD,
    onMouseDown: (event) => {
      event.preventDefault()
      if (event.button === 0) void submit(ctx)
    },
  })
  dialog.send = send
  dialog.frame.add(send, dialog.frame.getChildren().indexOf(dialog.error))
}

export function track(ctx: DialogContext, dialog: ModalState, field: Field) {
  dialog.fields.push(field)
  field.on("focused", () => {
    if (ctx.state.modal !== dialog) return
    dialog.index = dialog.fields.indexOf(field)
    reveal(dialog, field)
  })
}

export function reveal(dialog: ModalState, field: Field) {
  let parent = field.parent
  while (parent && parent !== dialog.form) parent = parent.parent
  if (!parent) return
  const top = field.y - dialog.form.viewport.y
  const bottom = top + field.height - dialog.form.viewport.height
  if (top < 0) dialog.form.scrollBy(top - 1)
  if (bottom > 0) dialog.form.scrollBy(bottom + 1)
}
