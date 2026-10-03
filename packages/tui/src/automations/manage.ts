import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { form, remove } from "./form"
import { runs } from "./runs"
import type { AutomationsContext, Loop } from "./types"

/** The action menu for one automation: run now, pause or resume, runs, edit, delete. */
export function manage(ctx: AutomationsContext, loop: Loop) {
  const { dialogs } = ctx
  const dialog = dialogs.open(label(loop.name, 60), false, 20)
  if (!dialog) return
  const loops = ctx.connection.client.loops
  const toggle =
    loop.status === "paused"
      ? (["Resume", "Resumed.", loops.resume] as const)
      : (["Pause", "Paused.", loops.pause] as const)
  const actions = [
    { name: "Run now", run: () => act(ctx, loop, "Started a run.", () => loops.runNow({ loopID: loop.id })) },
    { name: toggle[0], run: () => act(ctx, loop, toggle[1], () => toggle[2]({ loopID: loop.id })) },
    { name: "Runs", run: () => runs(ctx, loop) },
    { name: "Edit", run: () => form(ctx, loop) },
    { name: "Delete", run: () => remove(ctx, loop) },
  ]
  const list = new SelectRenderable(ctx.renderer, {
    height: actions.length,
    options: actions.map((action) => ({ name: action.name, description: "" })),
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
  dialog.error.content = "Enter choose · Esc close"
  list.focus()
}

function act(ctx: AutomationsContext, loop: Loop, done: string, request: () => Promise<unknown>) {
  const dialog = ctx.dialogs.open(label(loop.name, 60), false, 12)
  if (!dialog) return
  dialog.form.add(new TextRenderable(ctx.renderer, { content: "Working…", fg: color.muted }))
  dialog.submit = async () => {
    await request()
    ctx.say(done)
  }
  void ctx.dialogs.submit()
}
