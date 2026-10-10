import type { LaunchDraft } from "../state"
import type { LaunchForm } from "./context"

/** Copies the widgets back into the draft. */
export function saveDraft(form: LaunchForm) {
  const { current, directory, agent, model, workspace, task } = form
  const requested = directory.value.trim()
  // A pending discovery has no selection for the new directory. Never
  // relabel the old directory's agent as a choice belonging to the new one.
  current.agent =
    form.loaded === requested
      ? agent.getSelectedIndex() > 0
        ? form.choices[agent.getSelectedIndex() - 1]
        : undefined
      : current.directory === requested
        ? current.agent
        : undefined
  current.prompt = task.plainText
  current.cursor = task.cursorOffset
  current.directory = requested
  current.isolate = workspace.getSelectedIndex() === 1
  if (model.value.trim() !== current.model) current.variant = undefined
  current.model = model.value.trim()
}

/** Adopts the locked original submission, if one exists, over the widget values. */
export function adoptSubmission(current: LaunchDraft) {
  const submitted = current.start.input()
  if (submitted) Object.assign(current, submitted, { model: submitted.model ?? "" })
  return submitted
}
