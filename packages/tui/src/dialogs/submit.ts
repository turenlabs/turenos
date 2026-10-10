import { BoxRenderable, fg, t } from "@opentui/core"
import { errorText } from "../server"
import { color } from "../theme"
import type { ModalState } from "../state"
import type { DialogContext } from "./context"
import { close } from "./lifecycle"

export async function submit(ctx: DialogContext) {
  const current = ctx.state.modal
  if (!current?.submit || current.busy) return
  if (current.beforeSubmit?.()) return
  current.busy = true
  if (current.send) current.send.content = "[ Sending... ]"
  current.error.height = 2
  current.error.content = "Submitting…"
  ctx.hooks.changed(false)
  const shield = new BoxRenderable(ctx.renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 20,
    backgroundColor: "#00000001",
    onMouse: (event) => {
      event.preventDefault()
      event.stopPropagation()
    },
  })
  if (current.docked) ctx.ui.root.add(shield)
  if (!current.docked) current.box.add(shield)
  try {
    await current.submit()
    if (ctx.state.closed) return
    current.busy = false
    close(ctx, false)
    await ctx.hooks.submitted()
    current.afterSubmit?.()
  } catch (error) {
    if (ctx.state.closed) return
    showSubmitError(ctx, current, error)
  } finally {
    if (!shield.isDestroyed) shield.destroyRecursively()
  }
}

function showSubmitError(ctx: DialogContext, current: ModalState, error: unknown) {
  current.error.height = current.reference ? 6 : 4
  current.error.content = t`${fg(color.muted)(`${current.editor ? "Enter in message / " : ""}Ctrl+S retry · Esc ${current.save ? "keep draft" : "close"}${current.discard ? " · F4 discard" : ""}\n${current.reference ? `Session: ${current.reference}\nCtrl+O inspect this session\n` : ""}`)}${fg(color.error)(`! ${errorText(error)}`)}`
  current.error.fg = color.muted
  current.busy = false
  if (current.send) current.send.content = "[ Send (Enter) ]"
  ctx.ui.resize()
  ctx.hooks.changed(false)
}
