import type { SelectRenderable, TextRenderable } from "@opentui/core"
import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { display } from "../messages"
import { errorText, type Connection, type Session } from "../server"
import { label, type DashboardState, type ModalState } from "../state"
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
  request: number
  acting: boolean
}

export const keys = "Enter send now · Ctrl+E edit · Ctrl+D discard · Ctrl+R refresh · Esc close"

export async function refresh(dock: Dock, note = "") {
  const { ctx, session, dialog, text, list } = dock
  const version = ++dock.request
  try {
    const result = waiting(await ctx.connection.client.sessions.pendingInputs({ sessionID: session.id }))
    if (version !== dock.request || ctx.state.modal !== dialog) return
    dock.inputs = result.toSorted((a, b) => a.admittedSeq - b.admittedSeq)
    list.options = dock.inputs.map((input) => ({
      name: label(input.prompt.text, 90),
      description: `${input.delivery === "queue" ? "Queued until the agent is idle" : "Steering · delivered at the next step"} · ${new Date(input.timeCreated).toLocaleTimeString()}`,
    }))
    list.visible = dock.inputs.length > 0
    text.content = dock.inputs.length
      ? `For: ${label(session.title || session.id, 100)}\n\n${display(dock.inputs[list.getSelectedIndex()]?.prompt.text ?? "", 4000)}`
      : "Nothing is waiting. Messages the agent has already read appear in the transcript."
    dialog.error.content = `${note ? `${note}\n` : ""}${dock.inputs.length ? keys : "Ctrl+R refresh · Esc close"}`
  } catch (error) {
    if (version !== dock.request || ctx.state.modal !== dialog) return
    list.visible = false
    text.content = `Queued messages unavailable: ${errorText(error)}`
    dialog.error.content = "Ctrl+R retry · Esc close"
  }
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
  try {
    const messageID = input.id
    const done =
      kind === "steer"
        ? await ctx.connection.client.sessions.inputSteer({ sessionID: session.id, messageID })
        : await ctx.connection.client.sessions.inputCancel({ sessionID: session.id, messageID })
    if (ctx.state.modal !== dialog) return
    if (!done) return await refresh(dock, "The agent already received that message.")
    if (kind === "edit" && !ctx.drafts.restore(session, messageID, input.prompt.text)) return keep(dock, input)
    if (kind === "edit") {
      ctx.dialogs.close(false)
      return ctx.drafts.reply()
    }
    await refresh(dock, kind === "steer" ? "Sent now; the agent reads it at its next step." : "Discarded.")
  } catch (error) {
    if (ctx.state.modal === dialog) dialog.error.content = `! ${errorText(error)}\n${keys}`
  } finally {
    dock.acting = false
  }
}

/** A draft appeared while the message was being cancelled: keep its text on screen to copy. */
function keep(dock: Dock, input: Input) {
  dock.dialog.refresh = undefined
  dock.inputs = []
  dock.list.visible = false
  dock.text.content = `Removed from the queue, but it could not reopen in the reply editor. Select it and press Ctrl+Y to copy it before closing.\n\n${display(input.prompt.text, 32000)}`
  dock.dialog.error.content = "Ctrl+Y copies the selection · Esc close"
}

export async function discard(dock: Dock) {
  const id = dock.inputs[dock.list.getSelectedIndex()]?.id ?? ""
  if (dock.armed === id) {
    dock.armed = ""
    return act(dock, "cancel")
  }
  dock.armed = id
  dock.dialog.error.content = `Ctrl+D again discards this message.\n${keys}`
}
