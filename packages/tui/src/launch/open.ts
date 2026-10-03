import type { LaunchDraft } from "../state"
import { loadAgents } from "./agents"
import { chooseAgent, chooseModel, chooseVariant, launchKey } from "./choosers"
import type { LaunchDeps, LaunchForm, LaunchStore } from "./context"
import { adoptSubmission, saveDraft } from "./draft"
import { buildForm } from "./form"
import { submitLaunch } from "./submit"

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
  dialog.error.height = submitted ? 4 : 2
  dialog.error.content = submitted
    ? `Session: ${current.start.sessionID}\nCtrl+O inspect · Enter retry · Esc keep · F4 discard`
    : "Enter Send · Shift/Alt+Enter newline\nEsc keep · Ctrl+L Models · F4 discard"
  const target = () => ({ directory: form.directory.value.trim() })
  const locked = () => !!current.start.input()
  deps.slash.attach(dialog, form.task, target, locked)
  deps.mentions.attach(dialog, form.task, target, locked)
  dialogs.resize()
  form.task.focus()
  void loadAgents(form)
}

function startDraft(deps: LaunchDeps, store: LaunchStore): LaunchDraft {
  const { state, connection } = deps
  const snapshot = state.snapshot!
  const directoryName =
    state.workingDirectory ??
    snapshot.sessions.find((session) => session.id === state.selected)?.location.directory ??
    snapshot.location.directory
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

function bindActions(form: LaunchForm) {
  const { dialog } = form
  const { say } = form.deps
  form.directory.on("change", () => void loadAgents(form))
  dialog.save = () => {
    saveDraft(form)
    const submitted = adoptSubmission(form.current)
    say(submitted ? "Original submission kept · n to resume" : "Draft kept · n to resume")
  }
  dialog.discard = () => {
    form.store.draft = undefined
  }
  dialog.chooseModel = () => chooseModel(form)
  dialog.chooseAgent = () => chooseAgent(form)
  dialog.chooseVariant = () => chooseVariant(form)
  dialog.key = (key) => launchKey(form, key)
  dialog.submit = () => submitLaunch(form)
}
