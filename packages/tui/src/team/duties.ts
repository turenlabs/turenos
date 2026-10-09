import { act, runNow } from "../automations/manage"
import { form } from "../automations/form"
import type { Loop } from "../automations/types"
import { printableKey } from "../keys"
import { openPicker, type Choice } from "../picker"
import { label } from "../state"
import { scheduleText } from "../chrome"
import type { TeamOperations } from "./actions"
import { plural } from "./format"
import { online, reloaded } from "./selection"
import { viewOf, type Teammate, type TeamContext, type TeamView } from "./types"

const KEYS = "↑↓ choose · Enter open in Automations · r run · a assign · n new · Esc back"

export function dutiesOf(view: TeamView, mate: Teammate) {
  return view.duties.filter((duty) => duty.teammateID === mate.id)
}

function loops(ctx: TeamContext): readonly Loop[] {
  return ctx.state.snapshot?.loops ?? []
}

/**
 * A teammate's duties, each shown by its automation's name and status. The rows are those of the last draw:
 * Enter, `r` run now and the pickers act on them, never on a later poll's list.
 */
export function openDuties(ctx: TeamContext, ops: TeamOperations, mate: Teammate, back: () => void, note?: string) {
  const writable = !viewOf(ctx.state).room?.archived
  const picker = openPicker(ctx.renderer, ctx.dialogs, {
    title: `@${label(mate.handle, 32)} › Duties`,
    choices: [],
    back,
    keys: writable ? KEYS : "↑↓ choose · Enter open in Automations · Esc back",
  })
  if (!picker) return
  const rows = dutiesOf(viewOf(ctx.state), mate).map((duty) => ({
    duty,
    loop: loops(ctx).find((loop) => loop.id === duty.loopID),
  }))
  picker.text.content = [
    note,
    rows.length
      ? `${plural(rows.length, "duty", "duties")}.`
      : "No duties yet. a assigns an automation; n creates one.",
  ]
    .filter(Boolean)
    .join("\n")
  picker.fit()
  picker.set(
    rows.map(
      ({ duty, loop }): Choice => ({
        name: label(loop?.name ?? duty.loopID, 100),
        description: loop
          ? `${loop.status} · ${scheduleText(loop.schedule, loop.eventTrigger)}`
          : "Not in the automation list",
        run: () => (loop ? ctx.openAutomation(loop.id) : ctx.say("That automation is not in the list.", true)),
      }),
    ),
  )
  const select = picker.dialog.key
  const again = (saved?: string) => openDuties(ctx, ops, mate, back, saved)
  const owned = rows.map((row) => row.duty.loopID)
  const keys: Record<string, () => void> = {
    r: () => runDuty(ctx, rows[picker.list.getSelectedIndex()]?.loop, again),
    a: () => changing(ctx, writable, () => assign(ctx, ops, mate, owned, again)),
    n: () => changing(ctx, writable, () => create(ctx, mate, again)),
  }
  picker.dialog.key = (key) => {
    const action = keys[printableKey(key)]
    if (!action) return select?.(key) ?? false
    action()
    return true
  }
}

/** Assigning and creating duties change the room, so an archived one refuses and an unreachable server waits. */
function changing(ctx: TeamContext, writable: boolean, run: () => void) {
  if (!writable) return ctx.say("Archived rooms are read-only. Restore the room first.", true)
  if (online(ctx, "changing duties")) run()
}

function runDuty(ctx: TeamContext, loop: Loop | undefined, back: () => void) {
  if (!loop) return ctx.say("Select a duty whose automation is listed.", true)
  if (!online(ctx, "running the duty")) return
  ctx.dialogs.close(false)
  runNow(
    { ...ctx, say: (message, error) => ctx.say(error ? message : `Duty "${label(loop.name, 60)}": ${message}`, error) },
    loop,
    back,
  )
}

/** Existing automations that are not a duty yet. */
function assign(
  ctx: TeamContext,
  ops: TeamOperations,
  mate: Teammate,
  owned: string[],
  again: (saved?: string) => void,
) {
  const taken = new Set([...owned, ...viewOf(ctx.state).duties.map((duty) => duty.loopID)])
  const free = loops(ctx).filter((loop) => !taken.has(loop.id))
  ctx.dialogs.close(false)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `@${label(mate.handle, 32)} › Assign duty`,
    text: free.length ? "Choose an automation to make a duty." : "Every listed automation is already a duty.",
    choices: free.map((loop) => {
      const done = `Assigned "${label(loop.name, 60)}" to @${label(mate.handle, 32)}.`
      return {
        name: label(loop.name, 100),
        description: `${loop.status} · ${scheduleText(loop.schedule, loop.eventTrigger)}`,
        run: () =>
          act(
            ctx,
            `@${label(mate.handle, 32)} › Assign duty`,
            done,
            () => ctx.connection.client.team.dutyAttach({ teammateID: mate.id, loopID: loop.id }),
            // A dialog covers the status line, so the reopened list carries the confirmation itself.
            () => reloaded(ctx, ops, () => again(done)),
          ),
      }
    }),
    back: again,
  })
}

function create(ctx: TeamContext, mate: Teammate, again: () => void) {
  ctx.dialogs.close(false)
  form(ctx, undefined, again, {
    title: `@${label(mate.handle, 32)} › New duty`,
    teammateID: mate.id,
    directory: mate.directory,
  })
}
