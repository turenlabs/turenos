import { TextRenderable } from "@opentui/core"
import { form } from "../automations/form"
import { refused } from "../server"
import { label } from "../state"
import { color } from "../theme"
import type { TeamOperations } from "./actions"
import { confirm } from "./confirm"
import { textArea } from "./fields"
import { panelNote } from "./selection"
import { finite, viewOf, type FactoryRun, type Room, type TeamContext } from "./types"

const MAX_REQUEST = 4000

/** Ctrl+R: one bounded run. An earlier attempt that may have landed is sent again with its own ID and request. */
export function startRun(ctx: TeamContext, ops: TeamOperations, room: Room, back: () => void) {
  const pending = viewOf(ctx.state).pendingRuns.get(room.id)
  const dialog = ctx.dialogs.open(`Factory › # ${label(room.name, 40)} › Run`, false, 24)
  if (!dialog) return
  dialog.back = back
  dialog.afterSubmit = back
  const note = pending
    ? `An earlier attempt may have started. Ctrl+S sends it again with the same ID and request, so it cannot start a second run.\nRequest: ${pending.request ? label(pending.request, 400) : "(none)"}`
    : "Starts one bounded run: the coordinator plans, the teammates work, the coordinator checks."
  dialog.form.add(new TextRenderable(ctx.renderer, { content: note, fg: color.muted, wrapMode: "word" }))
  const request = pending
    ? undefined
    : textArea(ctx, dialog, `Request (optional, up to ${MAX_REQUEST} characters)`, "", 5)
  dialog.submit = () => submitRun(ctx, ops, room.id, request?.plainText ?? "")
  dialog.error.content = "Ctrl+S start the run · Esc back"
  if (request) request.focus()
  else dialog.form.focus()
}

async function submitRun(ctx: TeamContext, ops: TeamOperations, roomID: string, text: string) {
  if (!ctx.state.connected) throw new Error("Reconnect before starting a run.")
  const request = text.trim()
  if (request.length > MAX_REQUEST) throw new Error(`Keep the request to ${MAX_REQUEST} characters.`)
  const view = viewOf(ctx.state)
  const pending = view.pendingRuns.get(roomID) ?? { id: crypto.randomUUID(), request }
  view.pendingRuns.set(roomID, pending)
  // A run the last attempt started shows in the list after a reload.
  if (view.factoryRuns.some((run) => run.id === pending.id)) {
    view.pendingRuns.delete(roomID)
    return panelNote(ctx, "That run already started.")
  }
  const run = await ctx.connection.client.team
    .factoryRun({ roomID, id: pending.id, request: pending.request || undefined })
    .catch((error: unknown) => {
      // A definite refusal admitted nothing. Anything else may have started the run, so the ID is kept and the room reloaded.
      if (refused(error)) view.pendingRuns.delete(roomID)
      else void ops.sync()
      throw error
    })
  view.pendingRuns.delete(roomID)
  view.factoryRuns = [finite(run), ...view.factoryRuns.filter((item) => item.id !== run.id)]
  panelNote(ctx, "Factory run started.")
}

/** `x`: cancels the running run after a typed word. */
export function stopRun(ctx: TeamContext, run: FactoryRun, back: () => void) {
  confirm(ctx, {
    title: "Factory › Stop",
    warning: `Cancels run ${label(run.id, 60)} and its unfinished tasks. Work already done stays in its sessions. Failed or uncertain model work is not retried.`,
    word: "stop",
    verb: "stop the factory",
    back,
    done: back,
    run: async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before stopping the factory.")
      const stopped = finite(await ctx.connection.client.team.factoryRunCancel({ runID: run.id }))
      const view = viewOf(ctx.state)
      view.factoryRuns = [stopped, ...view.factoryRuns.filter((item) => item.id !== stopped.id)]
      panelNote(ctx, "Factory run cancelled.")
    },
  })
}

/** `t`: the duty form, with the factory's room and directory set; the server makes the coordinator the duty's owner. */
export function addTrigger(ctx: TeamContext, room: Room, back: () => void) {
  form(ctx, undefined, back, {
    title: `Factory › # ${label(room.name, 40)} › Trigger`,
    factoryRoomID: room.id,
    directory: room.factory?.config.directory,
  })
}
