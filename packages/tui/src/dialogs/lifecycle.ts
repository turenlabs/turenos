import type { DialogContext } from "./context"

// Keeps the renderer's automatic mouse focus inside the open form.
export function guardMouseFocus(ctx: DialogContext) {
  ctx.ui.root.onMouseDown = (event) => {
    if (!ctx.state.modal) return
    let target = event.target
    while (target && target !== ctx.state.modal.box) target = target.parent
    // Navigation handlers may save/close the form first. Otherwise keep the
    // renderer's automatic mouse focus inside the form, including same-row clicks.
    if (!target) event.preventDefault()
  }
}

export function close(ctx: DialogContext, save = true) {
  if (!ctx.state.modal || ctx.state.modal.busy) return
  const current = ctx.state.modal
  if (save) current.save?.()
  ctx.state.modal = undefined
  current.box.destroyRecursively()
  ctx.renderer.setCursorPosition(0, 0, false)
  ctx.hooks.changed(save)
}

// Every navigation entry point uses this policy. Only explicit Escape abandons
// a request without a saved draft; an in-flight submission cannot be abandoned.
export function navigate(ctx: DialogContext) {
  if (!ctx.state.modal) return true
  if (ctx.state.modal.busy || (!ctx.state.modal.save && !ctx.state.modal.allowNavigation)) return false
  ctx.state.modal.onNavigate?.()
  close(ctx)
  return true
}
