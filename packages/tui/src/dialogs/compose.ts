import { composeInEditor, editorArgv, MISSING_EDITOR } from "../editor"
import { errorText } from "../server"
import { color } from "../theme"
import type { DialogContext } from "./context"

/**
 * Hand the terminal to the operator's editor and take it back. The renderer
 * owns the screen and raw input, so the child runs with the renderer suspended
 * and the terminal is always reclaimed, including when the editor fails.
 */
export async function compose(ctx: DialogContext) {
  const current = ctx.state.modal
  const editor = current?.editor
  if (!current || !editor || current.busy) return
  if (current.editorLocked?.()) {
    current.error.content = "The original submission is locked. Retry it, or press F4 to discard the local draft."
    current.error.fg = color.error
    return
  }
  // Resolve the command before taking the terminal: with nothing to launch,
  // suspending and resuming would only flicker the screen.
  if (!editorArgv()) return ctx.hooks.say(MISSING_EDITOR, true)
  current.busy = true
  let suspended = false
  try {
    ctx.renderer.suspend()
    suspended = true
    // suspend() releases the terminal natively; this is a cheap reassertion so
    // a full-screen editor is never handed a raw-mode stdin.
    process.stdin.setRawMode?.(false)
    const edited = await composeInEditor(editor.plainText)
    if (ctx.state.closed || ctx.state.modal !== current || editor.isDestroyed) return
    editor.setText(edited)
    editor.cursorOffset = edited.length
    ctx.hooks.say(edited ? "Draft updated from your editor. Nothing was sent." : "The editor returned an empty draft.")
  } catch (error) {
    if (ctx.state.closed || ctx.state.modal !== current) return
    ctx.hooks.say(errorText(error), true)
  } finally {
    if (suspended && !ctx.renderer.isDestroyed) ctx.renderer.resume()
    current.busy = false
    if (!ctx.state.closed && !ctx.renderer.isDestroyed && ctx.state.modal === current && !editor.isDestroyed) {
      editor.focus()
      ctx.ui.resize()
    }
  }
}
