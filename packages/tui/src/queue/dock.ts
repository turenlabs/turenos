import type { SelectRenderable, TextRenderable } from "@opentui/core"
import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { display } from "../messages"
import { stamp } from "../menus/stamp"
import { errorText, refused, type Connection, type Session } from "../server"
import { label, sessionTitle, type DashboardState, type ModalState } from "../state"
import type { Input } from "./inputs"
import { editable, waiting } from "./inputs"

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
  /** Edits whose cancel got no answer: the message may be gone, so its copy is kept to reopen as the draft. */
  held: Map<string, Input>
  armed: string
  armedAt: number
  request: number
  acting: boolean
}

// Two lines that break between entries, so no key is split from its verb.
export const keys = "Enter send now · Ctrl+E edit · Ctrl+D twice discard\nCtrl+R refresh · Esc close"

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
      description: `${delivery(input, Object.hasOwn(ctx.state.snapshot?.active ?? {}, session.id))} · ${stamp(input.timeCreated)}`,
    }))
    list.visible = dock.inputs.length > 0
    // Keep the same message selected when others leave the queue, so Enter and Ctrl+D never retarget silently.
    const index = dock.inputs.findIndex((input) => input.id === previous)
    if (index >= 0) list.setSelectedIndex(index)
    const left = previous !== undefined && index < 0
    if (left || dock.armed !== dock.inputs[list.getSelectedIndex()]?.id) dock.armed = ""
    text.content = dock.inputs.length
      ? preview(session, dock.inputs[list.getSelectedIndex()])
      : "Nothing is waiting. Messages the agent has already read appear in the transcript."
    const notice =
      note || (left && dock.inputs.length ? "The selected message left the queue; check the one now selected." : "")
    dialog.error.content = `${notice ? `${notice}\n` : ""}${dock.inputs.length ? keys : "Ctrl+R refresh · Esc close"}`
    const listed = new Set(dock.inputs.map((input) => input.id))
    dock.held.forEach((_, id) => listed.has(id) && dock.held.delete(id))
    const gone = dock.held.values().next().value
    if (
      gone &&
      !reopen(dock, gone, "The earlier edit got no answer and the message has left the queue, so this is your copy.")
    ) {
      keep(
        dock,
        gone,
        "Removed from the queue, but it could not reopen in the reply editor (send or discard your reply draft, then Ctrl+R).",
      )
    }
  } catch (error) {
    if (version !== dock.request || ctx.state.modal !== dialog) return
    // Nothing is listed, so Enter, Ctrl+E and Ctrl+D must not act on a message that is no longer shown.
    dock.inputs = []
    dock.armed = ""
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
  const blocked =
    kind !== "edit"
      ? undefined
      : editable(input, session.location.directory)
        ? ctx.drafts.blocker(session.id, input.prompt.text)
        : "It has attachments the reply editor cannot carry, so editing would lose them. Ctrl+D twice discards it."
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
    if (!done && kind === "edit" && dock.held.has(messageID)) {
      // An earlier cancel got no answer, so "not found" cannot tell who removed it: reopen the kept copy.
      if (
        !reopen(
          dock,
          input,
          "The earlier edit got no answer, so this is your copy. It may already have reached the agent.",
        )
      )
        keep(dock, input)
      return
    }
    if (!done) return await refresh(dock, "The agent already received that message.")
    if (kind === "edit") {
      if (
        !reopen(
          dock,
          input,
          "Message taken out of the queue and reopened for editing. Ctrl+T switches Steer and Queue.",
        )
      )
        keep(dock, input)
      return
    }
    await refresh(dock, kind === "steer" ? "Sent now; the agent reads it at its next step." : "Discarded.")
  } catch (error) {
    if (ctx.state.modal !== dialog) return
    if (refused(error)) dialog.error.content = `! ${errorText(error)}\n${keys}`
    else {
      if (kind === "edit") dock.held.set(input.id, input)
      await unsure(dock, input, error)
    }
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
  dock.dialog.error.content = dock.held.has(input.id)
    ? "Ctrl+Y copies the selection · Ctrl+R reopens it as a draft · Esc close"
    : "Ctrl+Y copies the selection · Esc close"
}

/** Puts the message back into the reply draft and closes the dialog; false when the draft cannot take it. */
function reopen(dock: Dock, input: Input, note: string) {
  const { ctx, session } = dock
  if (!ctx.drafts.restore(session, input.id, input.prompt.text)) return false
  dock.held.delete(input.id)
  ctx.dialogs.close(false)
  ctx.drafts.reply()
  ctx.say(note)
  return true
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

/** The session, then the selected message in full, but only when its list row has not already shown all of it. */
export function preview(session: Session, input: Input | undefined) {
  const heading = `For: ${sessionTitle(session.title || session.id, 100)}`
  const full = display(input?.prompt.text ?? "", 4000)
  return !full || full === label(full, 90) ? heading : `${heading}\n\n${full}`
}
