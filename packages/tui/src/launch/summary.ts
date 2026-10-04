import { label } from "../state"
import type { LaunchForm } from "./context"

/** Rewrites the two-line context shown above the prompt from the current field values. */
export function summarize(form: LaunchForm) {
  const { current, directory, agent, model, workspace, context } = form
  const custom = [
    current.start.input()?.agent ??
      (directory.value.trim() === (form.loaded ?? current.directory) && agent.getSelectedIndex() > 0
        ? form.choices[agent.getSelectedIndex() - 1]
        : undefined),
    model.value.trim(),
  ]
    .filter(Boolean)
    .map((value) => label(value!))
  context.height = current.variant ? 3 : 2
  if (workspace.getSelectedIndex() === 1 && !current.worktree?.directory) custom.push("new worktree")
  context.content = `Directory: ${label(directory.value, 4096)}\nTab settings${custom.length ? ` · ${custom.join(" · ")}` : ""}${current.variant ? `\nModel variant ${label(current.variant)}` : ""}`
}
