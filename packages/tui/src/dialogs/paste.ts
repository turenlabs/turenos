import { TextareaRenderable, type PasteEvent } from "@opentui/core"
import { color } from "../theme"
import type { DialogContext } from "./context"

export function paste(ctx: DialogContext, event: PasteEvent) {
  if (ctx.ui.sizeNotice.visible) return event.preventDefault()
  const current = ctx.state.modal
  if (current?.busy) return event.preventDefault()
  const field = current?.fields[current.index]
  if (
    field instanceof TextareaRenderable &&
    (event.bytes.byteLength > 128000 || field.plainText.length + new TextDecoder().decode(event.bytes).length > 32000)
  ) {
    event.preventDefault()
    current!.error.content = "Task is limited to 32,000 characters. Paste a shorter message."
    current!.error.fg = color.error
  }
}
