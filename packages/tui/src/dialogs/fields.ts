import {
  BoxRenderable,
  InputRenderable,
  TextareaRenderable,
  TextRenderable,
  InputRenderableEvents,
  TextAttributes,
  fg,
  t,
  type CliRenderer,
  type ContentChangeEvent,
} from "@opentui/core"
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
  })
  dialog.form.add(frameField(ctx.renderer, field, 1))
  caption.onMouseDown = (event) => {
    event.preventDefault()
    field.focus()
  }
  track(ctx, dialog, field)
  clearStaleError(ctx, dialog, field)
  return field
}

/** Id of the row `frameField` makes, so a caption above an input is still found beside the row. */
export const fieldFrame = "field-frame"

/**
 * One row that shows a text input as a field in plain text: `[ value ]`. Background colours alone
 * left an empty input looking like blank space, and a placeholder looking like typed text.
 */
export function frameField(renderer: CliRenderer, field: InputRenderable, marginBottom = 0) {
  const edge = (content: string) => new TextRenderable(renderer, { content, fg: color.border, width: 2, flexShrink: 0 })
  const left = edge("[ ")
  const right = edge(" ]")
  field.flexGrow = 1
  field.flexShrink = 1
  field.minWidth = 0
  const paint = () => {
    if (left.isDestroyed) return
    left.fg = right.fg = field.focused ? color.accent : color.border
  }
  field.on("focused", paint)
  field.on("blurred", paint)
  const row = new BoxRenderable(renderer, { id: fieldFrame, flexDirection: "row", height: 1, flexShrink: 0, marginBottom })
  row.add(left)
  row.add(field)
  row.add(right)
  return row
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

function clearFailure(ctx: DialogContext, dialog: ModalState) {
  const hint = hints.get(dialog)
  if (!hint || !failed(dialog.error)) return
  dialog.error.content = hint.content
  dialog.error.height = hint.height
  dialog.error.fg = color.muted
  ctx.ui.resize()
}

/** A change in a field that has no text edit of its own (a list) drops a failure message, like typing does. */
export function clearFailureOf(dialog: ModalState) {
  const ctx = contexts.get(dialog)
  if (ctx) clearFailure(ctx, dialog)
}

/** Editing a field drops a failure message and brings back the hint the dialog started with. */
function clearStaleError(ctx: DialogContext, dialog: ModalState, field: InputRenderable | TextareaRenderable) {
  const remember = () => {
    if (!hints.has(dialog) && !failed(dialog.error))
      hints.set(dialog, { content: plain(dialog.error), height: dialog.error.height })
  }
  field.on("focused", remember)
  const edited = () => {
    remember()
    clearFailure(ctx, dialog)
  }
  if (field instanceof InputRenderable) return void field.on("input", edited)
  const changed = field.onContentChange
  field.onContentChange = (event: ContentChangeEvent) => {
    changed?.(event)
    edited()
  }
}

/** Dialogs by the context that opened them, so a field can submit its dialog. */
const contexts = new WeakMap<ModalState, DialogContext>()

/** A multi-line form field that drops a failure message on its next edit, like `input`. It chains the `onContentChange` the field has, so set its own handler first. */
export function clearOnEdit(dialog: ModalState, field: TextareaRenderable) {
  const ctx = contexts.get(dialog)
  if (ctx) clearStaleError(ctx, dialog, field)
}

/** Enter in a single-line field: on to the next field of the form, and from the last one, submit. */
export function enterAdvances(dialog: ModalState) {
  dialog.fields.forEach((field) => {
    if (!(field instanceof InputRenderable)) return
    field.on(InputRenderableEvents.ENTER, () => {
      const next = dialog.fields[dialog.fields.indexOf(field) + 1]
      const ctx = contexts.get(dialog)
      if (next) return next.focus()
      if (ctx?.state.modal === dialog) void submit(ctx)
    })
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
  // Enter sends once the word is typed, like Ctrl+S. With another word it shows the mismatch.
  field.on(InputRenderableEvents.ENTER, () => {
    const ctx = contexts.get(dialog)
    if (ctx?.state.modal === dialog) void submit(ctx)
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
  contexts.set(dialog, ctx)
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
