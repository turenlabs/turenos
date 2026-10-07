import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { errorText } from "../server"
import { label } from "../state"
import { stamp } from "../menus/stamp"
import { color } from "../theme"
import type { AutomationsContext, Loop } from "./types"

const keys = "↑↓ choose · Enter open session · Ctrl+D twice cancel a live run · Esc back"

/** Recent runs of one automation; Enter opens a run's session, a double Ctrl+D cancels a live run. */
export function runs(ctx: AutomationsContext, loop: Loop, back: () => void) {
  const { dialogs, state, connection } = ctx
  const dialog = dialogs.open(`Automation › ${label(loop.name, 40)} › Runs`, false, 30)
  if (!dialog) return
  dialog.back = back
  const text = new TextRenderable(ctx.renderer, { content: "Loading runs…", fg: color.muted })
  dialog.form.add(text)
  const list = runList(ctx)
  dialog.form.add(list)
  dialogs.track(dialog, list)
  let items: Awaited<ReturnType<typeof connection.client.loops.runList>> = []
  let armed: { id: string; until: number } | undefined
  let cancelling = false
  void connection.client.loops.runList({ loopID: loop.id }).then(
    (result) => {
      if (state.modal !== dialog) return
      items = result.slice(0, 50)
      text.content = items.length ? `${items.length} recent run${items.length === 1 ? "" : "s"}` : "No runs yet."
      list.options = items.map((run) => ({
        name: `${label(run.status, 20)} · ${run.time?.created === undefined ? label(run.id) : stamp(run.time.created)} · ${label(run.trigger ?? "", 40)}`,
        description: run.error ? label(run.error, 200) : "",
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
    // Key auto-repeat must not count as a press, and a cancel in flight is not sent again.
    if (cancelling || key.eventType === "repeat") return true
    if (armed?.id !== run.id || armed.until < Date.now()) {
      armed = { id: run.id, until: Date.now() + 2500 }
      dialog.error.content = `Ctrl+D again cancels this run.\n${keys}`
      return true
    }
    armed = undefined
    cancelling = true
    const done = (note: string) => {
      cancelling = false
      dialog.error.content = `${note}\n${keys}`
    }
    void connection.client.loops.runCancel({ loopID: loop.id, runID: run.id }).then(
      () => done("Run cancelled."),
      (error: unknown) => done(`! ${errorText(error)}`),
    )
    return true
  }
  dialog.error.content = "Esc back"
  list.focus()
}

function runList(ctx: AutomationsContext) {
  return new SelectRenderable(ctx.renderer, {
    height: 14,
    options: [],
    backgroundColor: color.panel,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
}
