import { InputRenderable, TextareaRenderable, TextRenderable, TextAttributes } from "@opentui/core"
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
  return field
}

export function prompt(ctx: DialogContext, dialog: ModalState, label: string, value = "", cursor = value.length) {
  const caption = new TextRenderable(ctx.renderer, { content: label, fg: color.text, attributes: TextAttributes.BOLD })
  dialog.form.add(caption)
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
    field.setText(field.plainText.slice(0, 32000))
    dialog.error.content = "Task is limited to 32,000 characters."
  }
  dialog.form.add(field)
  field.cursorOffset = Math.max(0, Math.min(cursor, value.length))
  dialog.editor = field
  addSendButton(ctx, dialog)
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
