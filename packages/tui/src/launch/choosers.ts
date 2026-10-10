import { matchesKey } from "../keys"
import type { LaunchForm } from "./context"
import { loadAgents } from "./agents"
import { saveDraft } from "./draft"

function locked(form: LaunchForm, what: string) {
  if (!form.current.start.input()) return false
  form.dialog.error.content = `The original submission is locked. Inspect it ${what}`
  return true
}

export function chooseModel(form: LaunchForm) {
  const { current } = form
  if (locked(form, "with Ctrl+O before changing its model.")) return
  saveDraft(form)
  form.deps.dialogs.close(false)
  form.deps.models.pick({
    directory: current.directory,
    current: current.model,
    choose: (value) => {
      if (current.model !== value) current.variant = undefined
      current.model = value
      form.reopen()
    },
    cancel: form.reopen,
  })
}

export function chooseAgent(form: LaunchForm) {
  if (locked(form, "with Ctrl+O before changing its agent.")) return
  form.dialog.settings?.()
  form.agent.focus()
  form.deps.dialogs.reveal(form.dialog, form.agent)
  void loadAgents(form)
}

export function chooseVariant(form: LaunchForm) {
  const { current, dialog, deps } = form
  if (locked(form, "before changing its variant.")) return
  saveDraft(form)
  const separator = current.model.indexOf("/")
  if (separator < 1 || separator === current.model.length - 1) {
    dialog.error.content = "Choose a model with Ctrl+L before selecting /effort."
    return
  }
  deps.dialogs.close(false)
  deps.variants.pick({
    directory: current.directory,
    model: { providerID: current.model.slice(0, separator), id: current.model.slice(separator + 1) },
    current: current.variant,
    choose: (variant) => {
      current.variant = variant
      // This picker closes after its callback; reopen only once its modal is gone.
      deps.state.modal?.box.once("destroyed", () =>
        queueMicrotask(() => {
          if (!deps.state.closed && !deps.state.modal) form.reopen()
        }),
      )
    },
    cancel: form.reopen,
  })
}

/** Ctrl+L browses models; Ctrl+O inspects a locked original submission. */
export function launchKey(form: LaunchForm, key: Parameters<NonNullable<LaunchForm["dialog"]["key"]>>[0]) {
  // Only Escape reaches this while the dialog is busy: it stops waiting for a worktree.
  if (form.preparing && matchesKey(key, "escape")) {
    form.preparing.abort()
    return true
  }
  if (matchesKey(key, "l", { ctrl: true })) {
    form.dialog.chooseModel?.()
    return true
  }
  if (!matchesKey(key, "o", { ctrl: true }) || !form.dialog.reference) return false
  form.dialog.save?.()
  form.deps.dialogs.close(false)
  form.deps.openSession(form.current.start.sessionID, true)
  return true
}
