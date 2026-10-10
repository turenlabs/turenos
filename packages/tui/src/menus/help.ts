import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import { color } from "../theme"
import type { MenuContext } from "./context"
import { helpSections } from "./help-text"

/** Width of the key column; the longest key ("Ctrl+P · Ctrl+X") leaves a gap before the text, a longer one wraps. */
export const keyWidth = 18

export function help(ctx: MenuContext) {
  const dialog = ctx.dialogs.open("Keyboard shortcuts")
  if (!dialog) return
  dialog.frame.maxWidth = 100
  helpSections.forEach(([title, rows], index) => {
    dialog.form.add(
      new TextRenderable(ctx.renderer, {
        content: title,
        fg: color.accent,
        attributes: TextAttributes.BOLD,
        marginTop: index ? 1 : 0,
      }),
    )
    for (const [keys, text] of rows) dialog.form.add(row(ctx, keys, text))
  })
  const hint = () => {
    const form = dialog.form
    const more = form.scrollTop + form.viewport.height < form.scrollHeight - 1
    // PgDn moves one viewport less a line, so pages are counted in those steps.
    const step = Math.max(1, form.viewport.height - 1)
    const last = Math.ceil(Math.max(0, form.scrollHeight - form.viewport.height) / step) + 1
    const page = more ? Math.min(last - 1, Math.floor(form.scrollTop / step) + 1) : last
    dialog.error.content = `${page}/${last} · ${more ? "More below · " : ""}PgUp/PgDn scroll · Esc close`
  }
  dialog.key = (key) => {
    if (key.name !== "pageup" && key.name !== "pagedown") return false
    dialog.form.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, dialog.form.viewport.height - 1))
    hint()
    return true
  }
  // The scroll box already listens to these to size its bar; add to its handler.
  for (const part of [dialog.form.content, dialog.form.viewport]) {
    const resized = part.onSizeChange
    part.onSizeChange = () => {
      resized?.call(part)
      hint()
    }
  }
  hint()
  dialog.form.focus()
}

/** A key column and a text column, so a wrapped line hangs under its own text and never under the key. */
function row(ctx: MenuContext, keys: string, text: string) {
  const line = new BoxRenderable(ctx.renderer, { flexDirection: "row", flexShrink: 0, width: "100%" })
  line.add(
    new TextRenderable(ctx.renderer, {
      content: keys,
      fg: color.text,
      attributes: TextAttributes.BOLD,
      width: keyWidth,
      flexShrink: 0,
      wrapMode: "word",
    }),
  )
  line.add(
    new TextRenderable(ctx.renderer, {
      content: text,
      fg: color.muted,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      wrapMode: "word",
    }),
  )
  return line
}
