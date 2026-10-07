import { TextRenderable, TextAttributes } from "@opentui/core"
import { errorText, httpStatus } from "../server"
import { color } from "../theme"
import { requireWord } from "../dialogs/fields"
import { waiting } from "../queue/inputs"
import { recipient, type RequestContext } from "./context"

/** `x` and `/stop`: stops the selected session's running turn at once, as Esc Esc does. */
export function interrupt(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to interrupt.")
  if (!stopRunning(ctx)) ctx.say("Nothing is running in this session.")
}

/**
 * Interrupts the selected session's turn when one is running; false when there is nothing to stop.
 * `next` is appended to the outcome, which replaces whatever the caller said meanwhile.
 */
export function stopRunning(ctx: RequestContext, next = "") {
  const id = ctx.state.selected
  if (ctx.state.tab !== "sessions" || !id || !Object.hasOwn(ctx.state.snapshot?.active ?? {}, id)) return false
  void ctx.connection.client.sessions
    .interrupt({ sessionID: id })
    .then(() => ctx.say(`${stopped(ctx, id)}${next ? ` ${next}` : ""}`))
    .catch((error: unknown) => ctx.say(`Could not stop the turn: ${errorText(error)}`))
  return true
}

/**
 * Esc Esc on the selected session: the first press arms, a second within 2 s interrupts a running turn
 * (as `x` does) or, for an idle session, opens the `/undo` dialog.
 */
export function escapeStop(ctx: RequestContext, rewind: () => void) {
  const id = ctx.state.selected
  if (ctx.state.tab !== "sessions" || !id || !ctx.state.snapshot) return false
  const action = Object.hasOwn(ctx.state.snapshot.active, id) ? "stop" : "rewind"
  if (action === "rewind" && !ctx.state.connected) return false
  if (ctx.stopArmed?.sessionID !== id || ctx.stopArmed.action !== action || ctx.stopArmed.until < Date.now()) {
    if (action === "rewind" && ctx.state.detail?.sessionID === id && !ctx.state.detail.messages.length) {
      ctx.say("Nothing to undo in this session.")
      return true
    }
    ctx.stopArmed = { sessionID: id, until: Date.now() + 2000, action }
    ctx.say(action === "stop" ? "Press Esc again to stop this turn" : "Press Esc again to rewind")
    return true
  }
  ctx.stopArmed = undefined
  if (action === "rewind") {
    rewind()
    return true
  }
  stopRunning(ctx)
  return true
}

function stopped(ctx: RequestContext, sessionID: string) {
  const held = waiting(ctx.state.detail?.sessionID === sessionID ? ctx.state.detail.pending : []).length
  if (!held) return "Session interrupted."
  return `Stopped. ${held} queued message${held === 1 ? " is" : "s are"} held: u to send or discard`
}

export function kill(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to kill.")
  const id = ctx.state.selected
  const confirmation = openConfirmation(ctx, id, {
    title: "Kill session",
    height: 20,
    body: "Interrupt this session and cancel its active subagent tasks?\nCancelled tasks cannot resume.\n\nType kill, then Ctrl+S to confirm.",
    hint: "Ctrl+S kill · Esc close",
    word: "kill",
  })
  if (!confirmation) return
  confirmation.dialog.submit = async () => {
    await ctx.connection.client.sessions.interrupt({ sessionID: id })
    const result = await cancelActiveTasks(ctx, id)
    const summary = `${result.cancelled} cancelled, ${result.failed} failed, ${result.gone} not listed`
    const older = result.more ? " Older tasks beyond the first 50 were not checked." : ""
    if (result.failed) throw new Error(`Session interrupted; tasks: ${summary}. Ctrl+S retries the cancels.${older}`)
    const cancelled = result.cancelled
      ? ` Cancelled ${result.cancelled} active task${result.cancelled === 1 ? "" : "s"}.`
      : ""
    ctx.say(`Session killed.${cancelled}${result.gone ? ` ${result.gone} not listed.` : ""}${older}`)
  }
}

/** The desktop's kill switch: interrupts every running session on this server. */
export function stopAll(ctx: RequestContext) {
  const dialog = ctx.dialogs.open("Stop all agents", false, 18)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content:
        "Interrupt every running session on this server, including other clients' work?\nQueued messages stay queued; nothing is deleted.\n\nType stop all, then Ctrl+S to confirm.",
      fg: color.text,
      wrapMode: "word",
    }),
  )
  const confirmation = ctx.dialogs.input(dialog, "Confirmation (type stop all)")
  dialog.submit = async () => {
    const result = await ctx.connection.client.sessions.interruptAll()
    if (result.failed) throw new Error(`${result.failed} session(s) did not stop; ${result.interrupted} stopped.`)
    ctx.say(result.interrupted ? `Stopped ${result.interrupted} session(s).` : "Nothing was running.")
  }
  dialog.error.content = "Ctrl+S stop all · Esc close"
  requireWord(dialog, confirmation, "stop all", ctx.dialogs.resize)
  confirmation.focus()
}

/** The typed-confirmation dialog shared by stop and kill; the caller sets `dialog.submit`. */
function openConfirmation(
  ctx: RequestContext,
  sessionID: string,
  options: { title: string; height: number; body: string; hint: string; word: string },
) {
  const dialog = ctx.dialogs.open(options.title, false, options.height, true)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: options.title,
      fg: color.text,
      attributes: TextAttributes.BOLD,
      height: 1,
      flexShrink: 0,
    }),
  )
  recipient(ctx, dialog, sessionID)
  dialog.form.add(new TextRenderable(ctx.renderer, { content: options.body, fg: color.text }))
  const input = ctx.dialogs.input(dialog, `Confirmation (type ${options.word})`)
  dialog.error.content = options.hint
  requireWord(dialog, input, options.word, ctx.dialogs.resize)
  ctx.dialogs.resize()
  input.focus()
  return { dialog, input }
}

async function cancelActiveTasks(ctx: RequestContext, sessionID: string) {
  const tasks = await ctx.connection.client.sessions.taskList({ sessionID, limit: 50 })
  const active = [...new Map([...tasks.data, ...tasks.active].map((task) => [task.id, task])).values()].filter((task) =>
    ["queued", "starting", "running"].includes(task.status),
  )
  const outcomes = await Promise.all(
    active.map((task) =>
      ctx.connection.client.sessions
        .taskCancel({ sessionID, taskID: task.id, expectedRevision: task.revision })
        .then(() => "cancelled" as const)
        .catch((error: unknown) => {
          // 404 and 409 mean the task finished or changed since the listing; the session interrupt covers new work.
          const status = httpStatus(error)
          return status === 404 || status === 409 ? ("gone" as const) : ("failed" as const)
        }),
    ),
  )
  return {
    cancelled: outcomes.filter((outcome) => outcome === "cancelled").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    gone: outcomes.filter((outcome) => outcome === "gone").length,
    more: !!tasks.cursor.next,
  }
}
