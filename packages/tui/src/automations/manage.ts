import { SelectRenderable, TextRenderable } from "@opentui/core"
import { matchesKey } from "../keys"
import { clock } from "../menus/stamp"
import { display } from "../messages"
import { errorText, refused } from "../server"
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
    { name: "Run now", run: () => runNow(ctx, loop, () => manage(ctx, loop)) },
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
  done: string | (() => string),
  request: () => Promise<unknown>,
  after?: () => void,
) {
  const dialog = ctx.dialogs.open(title, false, 12)
  if (!dialog) return
  dialog.afterSubmit = after
  dialog.form.add(new TextRenderable(ctx.renderer, { content: "Working…", fg: color.muted }))
  dialog.submit = async () => {
    await request()
    ctx.say(typeof done === "string" ? done : done())
  }
  void ctx.dialogs.submit()
}

/**
 * Starts a manual run. The server takes no retry ID and starts a new run for every request, so a request whose
 * answer was lost may already have started one. Ctrl+S after such a failure reads the run history instead of
 * sending again; it sends again only when the user confirms with a second Ctrl+S after "no new run".
 */
export function runNow(ctx: AutomationsContext, loop: Loop, back: () => void) {
  const loops = ctx.connection.client.loops
  // The runs that existed before the latest request, so a run that appears afterwards is the request's.
  const before = new Set<string>()
  let unsure = false
  let checked = false
  let found: Awaited<ReturnType<typeof loops.runList>>[number] | undefined
  const started = () => {
    if (!found) return "Started a run."
    return typeof found.time?.created === "number" ? `A run started at ${clock(found.time.created)}.` : "A run started."
  }
  act(
    ctx,
    `Automation › ${label(loop.name, 50)}`,
    started,
    async () => {
      const history = await loops.runList({ loopID: loop.id })
      if (unsure) {
        found = history.find((run) => run.trigger === "manual" && !before.has(run.id))
        if (found) return
        if (!checked) {
          checked = true
          throw new Error("No new run was recorded. Ctrl+S starts one.")
        }
        unsure = false
        checked = false
      }
      history.forEach((run) => before.add(run.id))
      await loops.runNow({ loopID: loop.id }).catch((error: unknown) => {
        if (refused(error)) throw error
        unsure = true
        throw new Error(`${errorText(error)} The run may have started: Ctrl+S checks the run history first.`)
      })
    },
    () => found && runs(ctx, loop, back, started()),
  )
}
