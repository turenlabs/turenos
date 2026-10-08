import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { form, remove } from "./form"
import { runs } from "./runs"
import type { AutomationsContext, Loop } from "./types"

/** The action menu for one automation: run now, pause or resume, runs, edit, delete. */
export function manage(ctx: AutomationsContext, loop: Loop, selected = 0) {
  const { dialogs } = ctx
  const title = `Automation › ${label(loop.name, 50)}`
  const dialog = dialogs.open(title, false, 20)
  if (!dialog) return
  const loops = ctx.connection.client.loops
  const toggle =
    loop.status === "paused"
      ? (["Resume", "Resumed.", loops.resume] as const)
      : (["Pause", "Paused.", loops.pause] as const)
  const actions = [
    { name: "Run now", run: () => act(ctx, title, "Started a run.", () => loops.runNow({ loopID: loop.id })) },
    { name: toggle[0], run: () => act(ctx, title, toggle[1], () => toggle[2]({ loopID: loop.id })) },
    { name: "Runs", run: () => runs(ctx, loop, () => manage(ctx, loop, 2)) },
    { name: "Edit", run: () => form(ctx, loop, () => manage(ctx, loop, 3)) },
    { name: "Delete", run: () => remove(ctx, loop, () => manage(ctx, loop, 4)) },
  ]
  const list = new SelectRenderable(ctx.renderer, {
    height: actions.length,
    options: actions.map((action) => ({ name: action.name, description: "" })),
    selectedIndex: selected,
    showDescription: false,
    backgroundColor: color.panel,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${label(loop.status)} · ${label(loop.location.directory, 200)}\n${display(loop.prompt, 400)}`,
      fg: color.muted,
      wrapMode: "word",
    }),
  )
  dialog.form.add(list)
  dialogs.track(dialog, list)
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    dialogs.close(false)
    actions[list.getSelectedIndex()]?.run()
    return true
  }
  dialog.error.content = "↑↓ choose · Enter select · Esc close"
  list.focus()
}

/** Runs one request in a small dialog that shows its failure and closes on success; `after` runs once it did. */
export function act(
  ctx: AutomationsContext,
  title: string,
  done: string,
  request: () => Promise<unknown>,
  after?: () => void,
) {
  const dialog = ctx.dialogs.open(title, false, 12)
  if (!dialog) return
  dialog.afterSubmit = after
  dialog.form.add(new TextRenderable(ctx.renderer, { content: "Working…", fg: color.muted }))
  dialog.submit = async () => {
    await request()
    ctx.say(done)
  }
  void ctx.dialogs.submit()
}
