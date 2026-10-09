import { clause } from "../messages"
import { errorText, httpStatus } from "../server"
import { label } from "../state"
import type { LaunchForm } from "./context"
import { summarize } from "./summary"

/** Discovers the directory's agents once per directory; a changed directory waits for the pending request. */
export function loadAgents(form: LaunchForm): Promise<void> {
  const { state, connection } = form.deps
  const { dialog, current, agent, directory } = form
  if (state.closed || state.modal !== dialog || !state.connected) return Promise.resolve()
  const requested = directory.value.trim()
  if (form.loaded === requested) return Promise.resolve()
  if (form.loading) return form.loading.then(() => loadAgents(form))
  form.loaded = undefined
  form.loadError = undefined
  agent.options = [{ name: "Loading agents…", description: "" }]
  agent.height = 1
  form.loading = connection
    .agents(requested)
    .then((result) => {
      if (state.closed || state.modal !== dialog || requested !== directory.value.trim()) return
      form.choices = result.map((item) => item.id)
      if (requested === current.directory && current.agent && !form.choices.includes(current.agent))
        form.choices.unshift(current.agent)
      form.loaded = requested
      agent.options = [
        { name: "Server default", description: "" },
        ...form.choices.map((id) => ({ name: label(id), description: "" })),
      ]
      // Every agent shows up to three rows; more scroll inside the list.
      agent.height = Math.min(3, agent.options.length)
      selectAgent(form, requested === current.directory && current.agent ? form.choices.indexOf(current.agent) + 1 : 0)
      summarize(form)
    })
    .catch((error) => {
      if (state.closed || state.modal !== dialog || requested !== directory.value.trim()) return
      form.loadError = error
      agent.options = [{ name: "Agents unavailable", description: "" }]
      const typed = typedFolder(form, requested, error)
      dialog.error.content = `${agentsFailure(form, requested, error)} ${typed ? "Fix Directory, or " : ""}Ctrl+S retries.`
    })
    .finally(() => {
      form.loading = undefined
    })
  return form.loading
}

/** Why discovery failed, as a sentence that submitting reports too. */
export function agentsFailure(form: LaunchForm, requested: string, error: unknown) {
  if (typedFolder(form, requested, error)) return `${label(requested, 80)} may not be a folder on the server.`
  return `Cannot load agents: ${clause(errorText(error))}.`
}

/** The form opens on a folder that exists, so a refusal after the user typed another one points at that folder (a worktree's is generated, not typed). */
function typedFolder(form: LaunchForm, requested: string, error: unknown) {
  const status = httpStatus(error)
  return (
    !form.current.worktree &&
    requested !== form.current.directory &&
    (status === 400 || status === 404 || (status ?? 0) >= 500)
  )
}

/** Sets the agent selection from code. The select's own change events are the user's choices, which this one is not. */
export function selectAgent(form: LaunchForm, index: number) {
  form.selecting = true
  form.agent.setSelectedIndex(index)
  form.selecting = false
}
