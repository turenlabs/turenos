import { TextRenderable, TextAttributes } from "@opentui/core"
import { color } from "../theme"
import { recipient, type RequestContext } from "./context"

export function interrupt(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to interrupt.")
  const id = ctx.state.selected
  const confirmation = openConfirmation(ctx, id, {
    title: "Interrupt session",
    height: 19,
    body: "Stop the current work in this session?\n\nType stop, then Ctrl+S to confirm.",
    hint: "Ctrl+S Send · Esc close",
  })
  if (!confirmation) return
  confirmation.dialog.submit = async () => {
    if (confirmation.input.value !== "stop") throw new Error("Type stop to confirm interruption.")
    await ctx.connection.client.sessions.interrupt({ sessionID: id })
    ctx.say("Session interrupted.")
  }
}

export function kill(ctx: RequestContext) {
  if (ctx.state.tab !== "sessions" || !ctx.state.selected) return ctx.say("Select a session to kill.")
  const id = ctx.state.selected
  const confirmation = openConfirmation(ctx, id, {
    title: "Kill session",
    height: 20,
    body: "Interrupt this session and cancel its active subagent tasks?\nCancelled tasks cannot resume.\n\nType kill, then Ctrl+S to confirm.",
    hint: "Ctrl+S Kill · Esc close",
  })
  if (!confirmation) return
  confirmation.dialog.submit = async () => {
    if (confirmation.input.value !== "kill") throw new Error("Type kill to confirm.")
    await ctx.connection.client.sessions.interrupt({ sessionID: id })
    const cancelled = await cancelActiveTasks(ctx, id)
    ctx.say(`Session killed.${cancelled ? ` Cancelled ${cancelled} active task${cancelled === 1 ? "" : "s"}.` : ""}`)
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
  const confirmation = ctx.dialogs.input(dialog, "Confirmation")
  dialog.submit = async () => {
    if (confirmation.value !== "stop all") throw new Error("Type stop all to confirm.")
    const result = await ctx.connection.client.sessions.interruptAll()
    if (result.failed) throw new Error(`${result.failed} session(s) did not stop; ${result.interrupted} stopped.`)
    ctx.say(result.interrupted ? `Stopped ${result.interrupted} session(s).` : "Nothing was running.")
  }
  dialog.error.content = "Ctrl+S Stop all · Esc close"
  confirmation.focus()
}

/** The typed-confirmation dialog shared by interrupt and kill; the caller sets `dialog.submit`. */
function openConfirmation(
  ctx: RequestContext,
  sessionID: string,
  options: { title: string; height: number; body: string; hint: string },
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
  const input = ctx.dialogs.input(dialog, "Confirmation")
  dialog.error.content = options.hint
  ctx.dialogs.resize()
  input.focus()
  return { dialog, input }
}

async function cancelActiveTasks(ctx: RequestContext, sessionID: string) {
  const tasks = await ctx.connection.client.sessions.taskList({ sessionID, limit: 50 })
  const active = [...new Map([...tasks.data, ...tasks.active].map((task) => [task.id, task])).values()].filter((task) =>
    ["queued", "starting", "running"].includes(task.status),
  )
  let cancelled = 0
  for (const task of active) {
    try {
      await ctx.connection.client.sessions.taskCancel({
        sessionID,
        taskID: task.id,
        expectedRevision: task.revision,
      })
      cancelled++
    } catch {
      // The task may finish between listing and cancellation; the session
      // interrupt above already stops new work.
    }
  }
  return cancelled
}
