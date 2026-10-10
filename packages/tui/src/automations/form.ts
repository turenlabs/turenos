import { TextRenderable } from "@opentui/core"
import { identifier, object } from "../response-validation"
import { refused } from "../server"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { defaultDirectory } from "../working-folders"
import { scheduleText } from "../chrome"
import { markFocus } from "./focus"
import { parseSchedule, scheduleInput, scheduleProblem } from "./schedule"
import type { AutomationsContext, Loop } from "./types"

/** What a create form from the Team tab fixes: the owner or room the new automation belongs to, and where it starts. */
export type Preset = { title: string; teammateID?: string; factoryRoomID?: string; directory?: string }

/**
 * The create form, or the edit form when `loop` is given; `back` returns to the menu that opened it. A `preset`
 * (create only) sends its owner with the create call and returns to `back` once the automation exists.
 */
export function form(ctx: AutomationsContext, loop?: Loop, back?: () => void, preset?: Preset) {
  const { dialogs, state } = ctx
  const dialog = dialogs.open(formTitle(loop, back, preset), false, 30)
  if (!dialog) return
  dialog.back = back
  if (preset) dialog.afterSubmit = back
  // Input fields write their text to the terminal as it is, so server text is stripped of control sequences first.
  const name = dialogs.input(dialog, "Name", display(loop?.name ?? "", 512))
  const prompt = dialogs.input(dialog, "Prompt the agent runs each time", display(loop?.prompt ?? "", 4096))
  // The server reports an event-triggered automation with a placeholder interval; sending it would replace the trigger.
  const schedule = loop?.eventTrigger
    ? undefined
    : dialogs.input(dialog, "Schedule: like every 1h, or cron (0 9 * * 1-5)", loop ? scheduleInput(loop) : "every 1h")
  if (loop?.eventTrigger) dialog.form.add(triggerNote(ctx, loop))
  const folder = loop
    ? undefined
    : dialogs.input(
        dialog,
        "Folder on the server",
        preset?.directory ?? defaultDirectory(state),
      )
  // Values line up under their captions: the focus arrow and the field's `[ ` take the same two columns.
  const fields = [name, prompt, schedule, folder].filter((field) => field !== undefined)
  fields.forEach(markFocus)
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
        .create({
          ...fields,
          location: { directory: folder!.value },
          ...(preset?.teammateID ? { teammateID: preset.teammateID } : {}),
          ...(preset?.factoryRoomID ? { factoryRoomID: preset.factoryRoomID } : {}),
        })
        .catch((error: unknown) => {
          // A definite refusal admitted nothing, so corrected fields may be sent again.
          if (refused(error)) created = false
          throw error
        }),
    )
    identifier(result.id)
    ctx.say("Automation created.")
  }
  dialog.error.content = `Tab next field · Ctrl+S save · Esc ${back ? "back" : "close"}`
  name.focus()
}

function formTitle(loop: Loop | undefined, back: (() => void) | undefined, preset: Preset | undefined) {
  if (!loop) return preset?.title ?? "New automation"
  return back ? `Automation › ${label(loop.name, 40)} › Edit` : "Edit automation"
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
  dialog.error.content = `Ctrl+S Delete · Esc ${back ? "back" : "close"}`
  dialog.form.focus()
}

/** An event-triggered automation's trigger, which only the desktop edits. */
function triggerNote(ctx: AutomationsContext, loop: Loop) {
  return new TextRenderable(ctx.renderer, {
    content: `Trigger: ${scheduleText(loop.schedule, loop.eventTrigger)}\nThe trigger is edited in the desktop.`,
    fg: color.muted,
    wrapMode: "word",
  })
}
