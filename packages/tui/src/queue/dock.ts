import type { SelectRenderable, TextRenderable } from "@opentui/core"
import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { display } from "../messages"
import { errorText, refused, type Connection, type Session } from "../server"
import { label, sessionTitle, type DashboardState, type ModalState } from "../state"
import type { Input } from "./inputs"
import { waiting } from "./inputs"

export type Drafts = {
  /** Why the text cannot become the session's reply draft, if it cannot. */
  blocker: (sessionID: string, text: string) => string | undefined
  restore: (session: Session, messageID: string, text: string) => boolean
  reply: () => void
}

export type QueueContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  drafts: Drafts
}

/** One open queued-messages dialog: its widgets and the mutable list state behind them. */
export type Dock = {
  ctx: QueueContext
  session: Session
  dialog: ModalState
  text: TextRenderable
  list: SelectRenderable
  inputs: Input[]
  armed: string
  armedAt: number
  request: number
  acting: boolean
}

export const keys = "Enter send now · Ctrl+E edit · Ctrl+D twice discard · Ctrl+R refresh · Esc close"

export async function refresh(dock: Dock, note = "") {
  const { ctx, session, dialog, text, list } = dock
  const version = ++dock.request
  try {
    const result = waiting(await ctx.connection.client.sessions.pendingInputs({ sessionID: session.id }))
    if (version !== dock.request || ctx.state.modal !== dialog) return
    const previous = dock.inputs[list.getSelectedIndex()]?.id
    dock.inputs = result.toSorted((a, b) => a.admittedSeq - b.admittedSeq)
    list.options = dock.inputs.map((input) => ({
      name: label(input.prompt.text, 90),
      description: `${delivery(input, Object.hasOwn(ctx.state.snapshot?.active ?? {}, session.id))} · ${new Date(input.timeCreated).toLocaleTimeString()}`,
    }))
    list.visible = dock.inputs.length > 0
    // Keep the same message selected when others leave the queue, so Enter and Ctrl+D never retarget silently.
    const index = dock.inputs.findIndex((input) => input.id === previous)
    if (index >= 0) list.setSelectedIndex(index)
    const left = previous !== undefined && index < 0
    if (left || dock.armed !== dock.inputs[list.getSelectedIndex()]?.id) dock.armed = ""
    text.content = dock.inputs.length
      ? `For: ${sessionTitle(session.title || session.id, 100)}\n\n${display(dock.inputs[list.getSelectedIndex()]?.prompt.text ?? "", 4000)}`
      : "Nothing is waiting. Messages the agent has already read appear in the transcript."
    const notice =
      note || (left && dock.inputs.length ? "The selected message left the queue; check the one now selected." : "")
    dialog.error.content = `${notice ? `${notice}\n` : ""}${dock.inputs.length ? keys : "Ctrl+R refresh · Esc close"}`
  } catch (error) {
    if (version !== dock.request || ctx.state.modal !== dialog) return
    list.visible = false
    text.content = `Queued messages unavailable: ${errorText(error)}`
    dialog.error.content = "Ctrl+R retry · Esc close"
  }
}

/** An idle session delivers nothing by itself, so a leftover message is held rather than waiting for the agent. */
function delivery(input: Input, running: boolean) {
  if (!running) return "Held · agent is idle · Enter sends now"
  return input.delivery === "queue" ? "Queued until the agent is idle" : "Steering · delivered at the next step"
}

export async function act(dock: Dock, kind: "steer" | "edit" | "cancel") {
  const { ctx, session, dialog, list } = dock
  const input = dock.inputs[list.getSelectedIndex()]
  if (!input || dock.acting) return
  // Cancelling removes the message from the server, so check it can reopen before cancelling it.
  const blocked = kind === "edit" ? ctx.drafts.blocker(session.id, input.prompt.text) : undefined
  if (blocked) {
    dialog.error.content = `${blocked} Enter sends it now instead.\n${keys}`
    return
  }
  dock.acting = true
  // Escape must not close the dialog while the server removes the message, or its text is lost.
  dialog.busy = true
  try {
    const messageID = input.id
    const done =
      kind === "steer"
        ? await ctx.connection.client.sessions.inputSteer({ sessionID: session.id, messageID })
        : await ctx.connection.client.sessions.inputCancel({ sessionID: session.id, messageID })
    dialog.busy = false
    if (ctx.state.modal !== dialog) return
    if (!done) return await refresh(dock, "The agent already received that message.")
    if (kind === "edit" && !ctx.drafts.restore(session, messageID, input.prompt.text)) return keep(dock, input)
    if (kind === "edit") {
      ctx.dialogs.close(false)
      ctx.drafts.reply()
      return ctx.say("Message taken out of the queue and reopened for editing. Ctrl+T switches Steer and Queue.")
    }
    await refresh(dock, kind === "steer" ? "Sent now; the agent reads it at its next step." : "Discarded.")
  } catch (error) {
    if (ctx.state.modal !== dialog) return
    if (refused(error)) dialog.error.content = `! ${errorText(error)}\n${keys}`
    else await unsure(dock, input, error)
  } finally {
    dialog.busy = false
    dock.acting = false
  }
}

/** The server's answer was lost, so the message may or may not have left the queue: show its text, then re-read. */
async function unsure(dock: Dock, input: Input, error: unknown) {
  const { ctx, session, dialog } = dock
  dock.text.content = display(input.prompt.text, 32000)
  dialog.error.content = `! ${errorText(error)}\nThe message may already be removed. Checking the queue…`
  dialog.busy = false
  const current = await ctx.connection.client.sessions
    .pendingInputs({ sessionID: session.id })
    .then(waiting, () => undefined)
  if (ctx.state.modal !== dialog) return
  if (current?.some((item) => item.id === input.id))
    return refresh(dock, `! ${errorText(error)}\nThe message is still queued.`)
  keep(
    dock,
    input,
    current
      ? "No answer was received, and the message is no longer in the queue: it was removed or already delivered."
      : "No answer was received, and the queue could not be read: the message may already be removed.",
  )
}

/** The message left the queue without reaching a reply draft: keep its text on screen to copy. */
function keep(
  dock: Dock,
  input: Input,
  reason = "Removed from the queue, but it could not reopen in the reply editor.",
) {
  dock.dialog.refresh = undefined
  dock.inputs = []
  dock.list.visible = false
  dock.text.content = `${reason} Select it and press Ctrl+Y to copy it before closing.\n\n${display(input.prompt.text, 32000)}`
  dock.dialog.error.content = "Ctrl+Y copies the selection · Esc close"
}

export async function discard(dock: Dock) {
  const id = dock.inputs[dock.list.getSelectedIndex()]?.id ?? ""
  if (dock.armed === id && Date.now() - dock.armedAt < 3000) {
    dock.armed = ""
    return act(dock, "cancel")
  }
  dock.armed = id
  dock.armedAt = Date.now()
  dock.dialog.error.content = `Ctrl+D again discards this message within 3 seconds.\n${keys}`
}
