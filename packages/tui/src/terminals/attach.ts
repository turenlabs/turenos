import { attachTerminal, type AttachTarget } from "../attach"
import { identifier } from "../response-validation"
import { errorText } from "../server"
import { label } from "../state"
import { selected, target, where, type Context } from "./context"

/** Hands the whole terminal to the PTY until it detaches or exits, then redraws the dashboard. */
export async function attach(ctx: Context, pty: AttachTarget) {
  if (!ctx.state.connected) return ctx.say("Reconnect before attaching to a terminal.", true)
  if (!ctx.dialogs.navigate()) return
  ctx.renderer.suspend()
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdout.write(`\x1b[2J\x1b[H\x1b[2m${label(pty.title, 80)} on the server · Ctrl+] detaches\x1b[0m\r\n`)
  const result = await attachTerminal({
    url: new URL(ctx.connection.address),
    api: ctx.connection.api,
    resize: (size) => ctx.connection.client.ptys.update({ ptyID: pty.id, location: where(pty), size }),
    target: pty,
    stdin: process.stdin,
    stdout: process.stdout,
  }).finally(() => {
    process.stdin.pause()
    if (!ctx.renderer.isDestroyed) ctx.renderer.resume()
  })
  if (ctx.state.closed) return
  if (result.reason === "failed") ctx.say(`Terminal connection failed: ${result.detail}`, true)
  else
    ctx.say(result.reason === "exited" ? "The terminal exited." : "Detached. The terminal keeps running on the server.")
  void ctx.refresh()
}

export function open(ctx: Context) {
  const terminal = selected(ctx)
  if (!terminal) return
  if (terminal.status === "exited")
    return ctx.say(
      `This terminal exited${terminal.exitCode === undefined ? "" : ` (code ${terminal.exitCode})`}. d closes it.`,
    )
  void attach(ctx, target(terminal))
}

/** The session's shared terminal, created on first use; the agent sees what you type there. */
export async function shared(ctx: Context) {
  const session = ctx.state.snapshot?.sessions.find((item) => item.id === ctx.state.selected)
  if (ctx.state.tab !== "sessions" || !session) return ctx.say("Select a session first.")
  try {
    const terminal = await ctx.connection.client.sessions.createTerminal({ sessionID: session.id })
    identifier(terminal.ptyID, "pty_")
    await attach(ctx, {
      id: terminal.ptyID,
      title: `Shared terminal · ${session.title || session.id}`,
      directory: session.location.directory,
      workspace: terminal.workspaceID ?? session.location.workspaceID,
    })
  } catch (error) {
    ctx.say(`Session terminal unavailable: ${errorText(error)}`, true)
  }
}
