import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer, type TextareaRenderable } from "@opentui/core"
import { markFocus } from "../automations/focus"
import { fieldFrame } from "../dialogs/fields"
import { followText } from "../suggest/editor-height"
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
  hugContent(dialog)
  // Wide terminals get a wider form; the shared dialog frame stops at 88 columns.
  dialog.frame.maxWidth = 120
  const ui = { settingsOpen: false }
  const task = dialogs.prompt(dialog, "What would you like to do?", current.prompt, current.cursor)
  // The launch has no shell handling, so it must not advertise `! shell`.
  task.placeholder = "Describe the task… / commands · @ files"
  dialog.editorLocked = () => !!current.start.input()
  followText(task, 3, 8)
  frameTask(renderer, dialog, task)
  const { directory, agent, model, workspace } = addSettings(deps, dialog, current)
  // Both go above the form, so creating them after its fields keeps the layout.
  const logo = createLogo(renderer, state, dialog, ui)
  const context = createContext(renderer, dialog, () => {
    directory.focus()
    dialogs.reveal(dialog, directory)
  })
  dialog.frame.add(context, 0)
  dialog.frame.add(logo.logo, 0)
  collapseSettings(dialog, ui, logo.resize, store)
  for (const field of [task, directory, agent, model, workspace]) markFocus(field)
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

/** Puts a left bar beside the prompt, so an empty prompt reads as a field like the framed single-line inputs. */
function frameTask(renderer: CliRenderer, dialog: ModalState, task: TextareaRenderable) {
  // The input frames' id keeps the caption's focus arrow beside the row.
  const frame = new BoxRenderable(renderer, {
    id: fieldFrame,
    border: ["left"],
    borderColor: color.border,
    paddingLeft: 1,
    marginBottom: 1,
    flexShrink: 0,
  })
  const paint = () => {
    if (!frame.isDestroyed) frame.borderColor = task.focused ? color.accent : color.border
  }
  task.on("focused", paint)
  task.on("blurred", paint)
  task.marginBottom = 0
  const index = dialog.form.getChildren().indexOf(task)
  dialog.form.remove(task)
  frame.add(task)
  dialog.form.add(frame, index)
}

/** The part Tab reveals: directory, agent, model and workspace under one heading. */
function addSettings(deps: LaunchDeps, dialog: ModalState, current: LaunchDraft) {
  const { renderer, dialogs } = deps
  dialog.form.add(
    new TextRenderable(renderer, { content: "Settings", fg: color.text, attributes: TextAttributes.BOLD }),
  )
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
  // The captions above each field already separate them; spare rows keep every setting on a short terminal.
  for (const field of [directory, model]) if (field.parent) field.parent.marginBottom = 0
  return { directory, agent, model, workspace }
}

function wireSummary(form: LaunchForm) {
  const summary = () => summarize(form)
  form.directory.on("input", summary)
  form.model.on("input", () => {
    // A frozen retry resends its original fields, so an edit here must not strip the variant it carries.
    if (!form.current.start.input() && form.model.value.trim() !== form.current.model) form.current.variant = undefined
    summary()
  })
  form.agent.on("selectionChanged", () => {
    // An explicit choice replaces the agent kept for a worktree retry.
    if (!form.selecting && form.current.worktree) form.current.worktree.agent = undefined
    summary()
  })
  form.workspace.on("selectionChanged", summary)
  const reveal = form.dialog.settings
  form.dialog.settings = () => {
    reveal?.()
    summary()
  }
  summary()
}

/** Hides the settings fields until Tab or a click on the summary reveals them, unless they were open before. */
function collapseSettings(
  dialog: ModalState,
  ui: { settingsOpen: boolean },
  resizeLogo: () => void,
  store: LaunchStore,
) {
  const settings = dialog.form.getChildren().slice(2)
  settings.forEach((field) => {
    field.visible = false
  })
  dialog.settings = () => {
    ui.settingsOpen = true
    // Once opened they stay open when the dialog reopens after a model choice, Esc or Ctrl+L.
    store.settings = true
    resizeLogo()
    settings.forEach((field) => {
      field.visible = true
    })
  }
  if (store.settings) dialog.settings()
}

/** The dialog is as tall as its content, not a fixed block with empty rows above Send. */
function hugContent(dialog: ModalState) {
  dialog.frame.height = "auto"
  dialog.form.flexGrow = 0
  dialog.form.flexShrink = 1
  dialog.form.content.minHeight = 0
}
