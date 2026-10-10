import type { LaunchDraft } from "../state"
import { loadAgents } from "./agents"
import { chooseAgent, chooseModel, chooseVariant, launchKey } from "./choosers"
import type { LaunchDeps, LaunchForm, LaunchStore } from "./context"
import { adoptSubmission, saveDraft } from "./draft"
import { buildForm } from "./form"
import { submitLaunch } from "./submit"
import { color } from "../theme"
import { defaultDirectory } from "../working-folders"

/** Opens the New session dialog over the kept draft, or over a fresh one for the working directory. */
export function openLaunch(deps: LaunchDeps, store: LaunchStore, reopen: () => void) {
  const { state, dialogs, say } = deps
  if (!dialogs.navigate()) return
  const snapshot = state.snapshot
  if (!snapshot || (!state.connected && !store.draft))
    return say("Connect to the server before launching an agent.", true)
  const dialog = dialogs.open("New session", true)
  if (!dialog) return
  const current = startDraft(deps, store)
  const submitted = adoptSubmission(current)
  const form = buildForm(deps, store, reopen, dialog, current)
  bindActions(form)
  dialog.reference = submitted ? current.start.sessionID : undefined
  const hint = submitted
    ? `Session: ${current.start.sessionID}\nCtrl+O inspect · Enter retry · Esc keep submission · F4 discard`
    : "Enter send · Shift/Alt+Enter newline\nEsc keep draft · F4 discard"
  dialog.error.height = submitted ? 4 : 2
  dialog.error.content = hint
  clearErrorOnEdit(form, hint, dialog.error.height)
  const target = () => ({ directory: form.directory.value.trim() })
  const locked = () => !!current.start.input()
  deps.slash.attach(dialog, form.task, target, locked)
  deps.mentions.attach(dialog, form.task, target, locked)
  dialogs.resize()
  form.task.focus()
  void loadAgents(form)
}

/** A failed send leaves its styled message up; typing in the task brings the dialog's own hint back. */
function clearErrorOnEdit(form: LaunchForm, hint: string, height: number) {
  const { dialog, task } = form
  const limit = task.onContentChange
  task.onContentChange = (event) => {
    limit?.(event)
    if (typeof dialog.error.content === "string") return
    dialog.error.content = hint
    dialog.error.height = height
    dialog.error.fg = color.muted
    form.deps.dialogs.resize()
  }
}

function startDraft(deps: LaunchDeps, store: LaunchStore): LaunchDraft {
  const { state, connection } = deps
  const directoryName = defaultDirectory(state)
  const defaults = store.defaults?.directory === directoryName ? store.defaults : undefined
  store.draft ??= {
    directory: directoryName,
    agent: defaults?.agent,
    model: defaults ? defaults.model : "",
    variant: defaults?.variant,
    prompt: "",
    start: connection.launch(),
  }
  return store.draft
}

function hasContent(draft: LaunchDraft) {
  return !!(draft.prompt.trim() || draft.agent || draft.model || draft.isolate)
}

function bindActions(form: LaunchForm) {
  const { dialog } = form
  const { say } = form.deps
  form.directory.on("change", () => void loadAgents(form))
  dialog.save = () => {
    saveDraft(form)
    const submitted = adoptSubmission(form.current)
    // Nothing typed and nothing chosen is no draft: it is neither kept nor offered for resuming.
    if (!submitted && !hasContent(form.current)) return void (form.store.draft = undefined)
    say(submitted ? "Original submission kept · n to resume" : "Draft kept · n to resume")
  }
  dialog.discard = () => {
    form.store.draft = undefined
    form.store.settings = undefined
  }
  dialog.chooseModel = () => chooseModel(form)
  dialog.chooseAgent = () => chooseAgent(form)
  dialog.chooseVariant = () => chooseVariant(form)
  dialog.key = (key) => launchKey(form, key)
  dialog.submit = () => submitLaunch(form)
}
