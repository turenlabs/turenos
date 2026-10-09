import { TextRenderable, TextAttributes } from "@opentui/core"
import { errorText } from "../server"
import { color } from "../theme"
import { requireWord } from "../dialogs/fields"
import { waiting } from "../queue/inputs"
import { recipient, waitingRequest, type RequestContext } from "./context"

/** `x` and `/stop`: interrupts the running session and cancels its subagent tasks, as Esc Esc does. */
export function interrupt(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to interrupt.")
  if (!stopRunning(ctx)) ctx.say("Nothing is running in this session.")
}

/**
 * Interrupts a running session and its subagent tasks; false when the parent is idle.
 * `next` is appended to the outcome, which replaces whatever the caller said meanwhile.
 */
export function stopRunning(ctx: RequestContext, next = "") {
  const id = ctx.state.selected
  if (ctx.state.tab !== "sessions" || !id || !Object.hasOwn(ctx.state.snapshot?.active ?? {}, id)) return false
  void ctx.connection.client.sessions
    .interrupt({ sessionID: id })
    .then(() => idle(ctx, id))
    .then(() => ctx.say(`${stopped(ctx, id)}${next ? ` ${next}` : ""}`))
    .catch((error: unknown) => ctx.say(`Could not stop the turn: ${errorText(error)}`))
  return true
}

/**
 * A notice said while the session still shows as running is dropped when the next update shows it idle, which
 * would erase the outcome of the stop; wait (at most 2 s) for that update first.
 */
async function idle(ctx: RequestContext, sessionID: string) {
  for (let waited = 0; waited < 2000 && Object.hasOwn(ctx.state.snapshot?.active ?? {}, sessionID); waited += 100)
    await Bun.sleep(100)
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
  // The server refuses to rewind a subagent session, so Esc Esc does not offer it there.
  if (action === "rewind" && ctx.state.snapshot.sessions.find((item) => item.id === id)?.parentID) return false
  if (ctx.stopArmed?.sessionID !== id || ctx.stopArmed.action !== action || ctx.stopArmed.until < Date.now()) {
    if (action === "rewind" && ctx.state.detail?.sessionID === id && !ctx.state.detail.messages.length) {
      ctx.say("Nothing to undo in this session.")
      return true
    }
    armStop(
      ctx,
      id,
      action,
      action === "stop" ? stopPrompt(ctx, id, " and cancel its tasks") : "Press Esc again to rewind",
    )
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

/** What the first Esc says; with a request pending it names that request, so Esc Esc is not mistaken for dismissing it. */
export function stopPrompt(ctx: RequestContext, sessionID: string, also = "") {
  const waiting = waitingRequest(ctx, sessionID)
  if (!waiting) return `Press Esc again to stop this turn${also}`
  return waiting === "permission"
    ? "Permission waiting · Enter reviews it · Esc again stops the turn"
    : "Question waiting · Enter answers it · Esc again stops the turn"
}

/** Arms the second Esc for 2 s and shows `prompt`, which is cleared when the window closes unanswered. */
export function armStop(ctx: RequestContext, sessionID: string, action: "stop" | "rewind", prompt: string) {
  const armed = { sessionID, until: Date.now() + 2000, action }
  ctx.stopArmed = armed
  ctx.say(prompt)
  // A later press or a replaced window leaves the notice to whoever owns it by then.
  setTimeout(() => {
    if (ctx.stopArmed !== armed) return
    ctx.stopArmed = undefined
    ctx.say("")
  }, 2000).unref?.()
}

function stopped(ctx: RequestContext, sessionID: string) {
  const held = waiting(ctx.state.detail?.sessionID === sessionID ? ctx.state.detail.pending : []).length
  if (!held) return "Session interrupted."
  return `Stopped. ${held} queued message${held === 1 ? "" : "s"} held · u sends or discards`
}

export function kill(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to kill.")
  const id = ctx.state.selected
  const confirmation = openConfirmation(ctx, id, {
    title: "Kill session",
    height: 20,
    body: "Interrupt this session and cancel its unfinished subagent tasks?\nCancelled tasks cannot resume.",
    hint: "Enter or Ctrl+S kill · Esc close",
    word: "kill",
  })
  if (!confirmation) return
  confirmation.dialog.submit = async () => {
    // Core awaits the full task-tree cancellation and reports failures before acknowledging.
    await ctx.connection.client.sessions.interrupt({ sessionID: id })
    ctx.say("Session killed.")
  }
}

/** The desktop's kill switch: interrupts every running session on this server. */
export function stopAll(ctx: RequestContext) {
  const dialog = ctx.dialogs.open("Stop all agents", false, 18)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content:
        "Interrupt every running session on this server, including other clients' work?\nSubagent tasks are cancelled; queued messages stay queued.",
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
  dialog.error.content = "Enter or Ctrl+S stop all · Esc close"
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
