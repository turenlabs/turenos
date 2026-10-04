import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText } from "../server"
import { label } from "../state"
import { stamp } from "../menus/stamp"
import { color } from "../theme"
import type { AutomationsContext, Loop } from "./types"

const keys = "Enter open run's session · Ctrl+D cancel a running run · Esc close"

/** Recent runs of one automation; Enter opens a run's session, a double Ctrl+D cancels a live run. */
export function runs(ctx: AutomationsContext, loop: Loop) {
  const { dialogs, state, connection } = ctx
  const dialog = dialogs.open(`Runs · ${label(loop.name, 50)}`, false, 30)
  if (!dialog) return
  const text = new TextRenderable(ctx.renderer, { content: "Loading runs…", fg: color.muted })
  dialog.form.add(text)
  const list = new SelectRenderable(ctx.renderer, {
    height: 14,
    options: [],
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.form.add(list)
  dialogs.track(dialog, list)
  let items: Awaited<ReturnType<typeof connection.client.loops.runList>> = []
  let armed = ""
  void connection.client.loops.runList({ loopID: loop.id }).then(
    (result) => {
      if (state.modal !== dialog) return
      items = result.slice(0, 50)
      text.content = items.length ? `${items.length} recent run${items.length === 1 ? "" : "s"}` : "No runs yet."
      list.options = items.map((run) => ({
        name: `${run.status} · ${run.time?.created === undefined ? label(run.id) : stamp(run.time.created)} · ${run.trigger}`,
        description: run.error ? label(run.error, 200) : run.sessionID ? "Enter opens its session" : "",
      }))
      dialog.error.content = keys
    },
    (error: unknown) => {
      if (state.modal === dialog) text.content = `Runs unavailable: ${errorText(error)}`
    },
  )
  dialog.key = (key) => {
    const run = items[list.getSelectedIndex()]
    if (matchesKey(key, "enter") && run?.sessionID) {
      dialogs.close(false)
      ctx.openSession(run.sessionID)
      return true
    }
    if (!matchesKey(key, "d", { ctrl: true }) || !run || !["claimed", "running"].includes(run.status)) return false
    if (armed !== run.id) {
      armed = run.id
      dialog.error.content = `Ctrl+D again cancels this run.\n${keys}`
      return true
    }
    void connection.client.loops.runCancel({ loopID: loop.id, runID: run.id }).then(
      () => (dialog.error.content = `Run cancelled.\n${keys}`),
      (error: unknown) => (dialog.error.content = `! ${errorText(error)}\n${keys}`),
    )
    return true
  }
  dialog.error.content = "Esc close"
  list.focus()
}
