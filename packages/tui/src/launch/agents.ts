import { errorText } from "../server"
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
      agent.setSelectedIndex(
        requested === current.directory && current.agent ? form.choices.indexOf(current.agent) + 1 : 0,
      )
      summarize(form)
    })
    .catch((error) => {
      if (state.closed || state.modal !== dialog || requested !== directory.value.trim()) return
      form.loadError = error
      dialog.error.content = `Cannot load agents: ${errorText(error)}. Ctrl+S retries.`
    })
    .finally(() => {
      form.loading = undefined
    })
  return form.loading
}
