import { TextRenderable } from "@opentui/core"
import { requireWord } from "../dialogs/fields"
import { color } from "../theme"
import type { TeamContext } from "./types"

/**
 * A confirmation dialog: the warning, then a field that must hold `word` before Ctrl+S sends. `back` reopens
 * the menu that opened it on Esc; `done` runs after the request succeeded.
 */
export function confirm(
  ctx: TeamContext,
  input: {
    title: string
    warning: string
    /** The word to type; without one the dialog only asks for Ctrl+S. */
    word?: string
    verb: string
    run: () => Promise<void>
    back?: () => void
    done?: () => void
  },
) {
  const dialog = ctx.dialogs.open(input.title, false, 23)
  if (!dialog) return
  dialog.form.add(new TextRenderable(ctx.renderer, { content: input.warning, fg: color.warning, wrapMode: "word" }))
  dialog.back = input.back
  dialog.submit = input.run
  dialog.afterSubmit = input.done
  dialog.error.content = `Ctrl+S ${input.verb} · Esc ${input.back ? "back" : "close"}`
  if (!input.word) return void dialog.form.focus()
  const confirmation = ctx.dialogs.input(dialog, `Confirmation (type ${input.word})`)
  requireWord(dialog, confirmation, input.word, ctx.dialogs.resize)
  confirmation.focus()
}
