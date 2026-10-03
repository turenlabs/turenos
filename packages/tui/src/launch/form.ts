import { TextRenderable } from "@opentui/core"
import { color } from "../theme"
import type { LaunchDeps, LaunchForm, LaunchStore } from "./context"
import { summarize } from "./summary"
import { createAgentSelect, createContext, createLogo, createWorkspaceSelect } from "./widgets"
import type { LaunchDraft, ModalState } from "../state"

/** Builds the dialog's widgets in their on-screen order and wires the summary line to them. */
export function buildForm(
  deps: LaunchDeps,
  store: LaunchStore,
  reopen: () => void,
  dialog: ModalState,
  current: LaunchDraft,
): LaunchForm {
  const { renderer, state, dialogs } = deps
  // Keep the prompt usable alongside the compact mark on small terminals.
  dialog.frame.gap = 0
  const ui = { settingsOpen: false }
  const logo = createLogo(renderer, state, dialog, ui)
  const context = createContext(renderer, dialog, () => {
    directory.focus()
    dialogs.reveal(dialog, directory)
  })
  dialog.frame.add(context, 0)
  dialog.frame.add(logo.logo, 0)
  const task = dialogs.prompt(dialog, "What would you like to do?", current.prompt, current.cursor)
  dialog.editorLocked = () => !!current.start.input()
  const directory = dialogs.input(dialog, "Directory on the server", current.directory)
  dialog.form.add(new TextRenderable(renderer, { content: "Agent · ↑/↓ to choose", fg: color.muted }))
  const agent = createAgentSelect(renderer, current.agent)
  dialog.form.add(agent)
  dialogs.track(dialog, agent)
  const model = dialogs.input(
    dialog,
    "Model · Ctrl+L browse, or enter provider/model",
    current.model,
    "Use server default",
  )
  dialog.form.add(new TextRenderable(renderer, { content: "Workspace · ↑/↓ to choose", fg: color.muted }))
  const workspace = createWorkspaceSelect(renderer, current.isolate)
  dialog.form.add(workspace)
  dialogs.track(dialog, workspace)
  collapseSettings(dialog, ui, logo.resize)
  agent.setSelectedIndex(current.agent ? 1 : 0)
  const form: LaunchForm = {
    deps,
    store,
    reopen,
    dialog,
    current,
    task,
    directory,
    agent,
    model,
    workspace,
    context,
    choices: current.agent ? [current.agent] : [],
    loaded: undefined,
    loadError: undefined,
    loading: undefined,
  }
  wireSummary(form)
  return form
}

function wireSummary(form: LaunchForm) {
  const summary = () => summarize(form)
  form.directory.on("input", summary)
  form.model.on("input", () => {
    if (form.model.value.trim() !== form.current.model) form.current.variant = undefined
    summary()
  })
  form.agent.on("selectionChanged", summary)
  form.workspace.on("selectionChanged", summary)
  summary()
}

/** Hides the agent, model and workspace fields until Tab or a click on the summary reveals them. */
function collapseSettings(dialog: ModalState, ui: { settingsOpen: boolean }, resizeLogo: () => void) {
  const settings = dialog.form.getChildren().slice(2)
  settings.forEach((field) => {
    field.visible = false
  })
  dialog.settings = () => {
    ui.settingsOpen = true
    resizeLogo()
    settings.forEach((field) => {
      field.visible = true
    })
  }
}
