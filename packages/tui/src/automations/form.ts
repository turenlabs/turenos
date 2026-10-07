import { TextRenderable } from "@opentui/core"
import { identifier, object } from "../response-validation"
import { refused } from "../server"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { scheduleText } from "../chrome"
import { markFocus } from "./focus"
import { parseSchedule, scheduleInput, scheduleProblem } from "./schedule"
import type { AutomationsContext, Loop } from "./types"

/** The create form, or the edit form when `loop` is given; `back` returns to the menu that opened it. */
export function form(ctx: AutomationsContext, loop?: Loop, back?: () => void) {
  const { dialogs, state } = ctx
  const dialog = dialogs.open(
    loop ? (back ? `Automation › ${label(loop.name, 40)} › Edit` : "Edit automation") : "New automation",
    false,
    30,
  )
  if (!dialog) return
  dialog.back = back
  const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
  // Input fields write their text to the terminal as it is, so server text is stripped of control sequences first.
  const name = dialogs.input(dialog, "Name", display(loop?.name ?? "", 512))
  const prompt = dialogs.input(dialog, "Prompt the agent runs each time", display(loop?.prompt ?? "", 4096))
  // The server reports an event-triggered automation with a placeholder interval; sending it would replace the trigger.
  const schedule = loop?.eventTrigger
    ? undefined
    : dialogs.input(dialog, "Schedule: every 2h, or cron (0 9 * * 1-5)", loop ? scheduleInput(loop) : "every 1h")
  if (loop?.eventTrigger)
    dialog.form.add(
      new TextRenderable(ctx.renderer, {
        content: `Trigger: ${scheduleText(loop.schedule, loop.eventTrigger)}\nThe trigger is edited in the desktop.`,
        fg: color.muted,
        wrapMode: "word",
      }),
    )
  const folder = loop
    ? undefined
    : dialogs.input(
        dialog,
        "Folder on the server",
        session?.location.directory ?? state.snapshot?.location.directory ?? "",
      )
  for (const field of [name, prompt, schedule, folder]) if (field) markFocus(field)
  let created = false
  dialog.submit = async () => {
    // An unchanged schedule is not sent again: that would restart its countdown.
    const when =
      schedule && (!loop || schedule.value.trim() !== scheduleInput(loop))
        ? parseSchedule(schedule.value, loop?.schedule)
        : {}
    if (!name.value.trim() || !prompt.value.trim()) throw new Error("Enter a name and a prompt.")
    if (!when) throw new Error(scheduleProblem(schedule!.value))
    const fields = { name: name.value.trim(), prompt: prompt.value.trim(), ...when }
    if (loop) {
      await ctx.connection.client.loops.edit({ loopID: loop.id, ...fields })
      return ctx.say("Automation saved.")
    }
    // A retry after an uncertain create must not add a second automation.
    if (created) throw new Error("The automation may already exist. Esc and check the Automations tab.")
    created = true
    const result = object(
      await ctx.connection.client.loops
        .create({ ...fields, location: { directory: folder!.value } })
        .catch((error: unknown) => {
          // A definite refusal admitted nothing, so corrected fields may be sent again.
          if (refused(error)) created = false
          throw error
        }),
    )
    identifier(result.id)
    ctx.say("Automation created.")
  }
  dialog.error.content = `Tab next field · Ctrl+S save · Esc ${back ? "back" : "cancel"}`
  name.focus()
}

export function remove(ctx: AutomationsContext, loop: Loop, back?: () => void) {
  const dialog = ctx.dialogs.open(
    back ? `Automation › ${label(loop.name, 40)} › Delete` : "Delete automation",
    false,
    16,
  )
  if (!dialog) return
  dialog.back = back
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${label(loop.name, 100)}\nFuture runs stop. Sessions it already started are kept.`,
      fg: color.warning,
      wrapMode: "word",
    }),
  )
  dialog.submit = async () => {
    await ctx.connection.client.loops.delete({ loopID: loop.id })
    ctx.say("Automation deleted.")
  }
  dialog.error.content = "Ctrl+S Delete · Esc cancel"
  dialog.form.focus()
}
