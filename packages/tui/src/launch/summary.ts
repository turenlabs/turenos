import { label } from "../state"
import type { LaunchForm } from "./context"

/** Rewrites the lines shown above the prompt from the current field values: folder, agent and model, and how to change them. */
export function summarize(form: LaunchForm) {
  const { current, directory, agent, model, workspace, context } = form
  const chosen =
    current.start.input()?.agent ??
    (directory.value.trim() === (form.loaded ?? current.directory) && agent.getSelectedIndex() > 0
      ? form.choices[agent.getSelectedIndex() - 1]
      : undefined)
  const summary = [
    label(chosen ?? form.deps.state.defaultAgent ?? "server default agent"),
    model.value.trim() ? label(model.value.trim()) : "server default model",
  ]
  if (workspace.getSelectedIndex() === 1 && !current.worktree?.directory) summary.push("new worktree")
  // Once the settings are open they show all of this, and their rows need the space.
  context.visible = !form.store.settings
  context.height = current.variant ? 4 : 3
  context.content = `Directory: ${label(directory.value, 4096)}\n${summary.join(" · ")}${current.variant ? ` · variant ${label(current.variant)}` : ""}\nTab: folder · agent · model · workspace`
}
