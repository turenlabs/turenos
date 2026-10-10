import { TextRenderable } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { CliRenderer } from "@opentui/core"
import type { Connection, Session } from "../server"
import { label, sessionTitle, type DashboardState } from "../state"
import { color } from "../theme"

export type SessionContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  updateRecipient: (session: Session) => void
  replyBlocked: (sessionID: string) => boolean
}

/** Opens a control dialog for the selected session, capturing it as the recipient. */
export function openControl(ctx: SessionContext, title: string) {
  const selected =
    ctx.state.tab === "sessions"
      ? ctx.state.snapshot?.sessions.find((session) => session.id === ctx.state.selected)
      : undefined
  if (!selected) return ctx.say("Select a session first.", true)
  if (!ctx.state.connected) return ctx.say("Reconnect before changing this session.", true)
  if (ctx.replyBlocked(selected.id))
    return ctx.say("Task-owned subagent: use its owning session. Nothing changed.", true)
  if (ctx.state.closed || !ctx.dialogs.navigate()) return
  const dialog = ctx.dialogs.open(title, false, 24)
  if (!dialog) return
  const session = structuredClone(selected)
  dialog.recipient = session
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `For: ${sessionTitle(session.title || session.id, 100)}\nSession: ${label(session.id, 80)}\nDirectory: ${label(session.location.directory, 200)}`,
      fg: color.muted,
      wrapMode: "word",
    }),
  )
  return { session, dialog }
}

export async function currentSession(ctx: SessionContext, session: Session) {
  if (!ctx.state.connected) throw new Error("Reconnect before changing this session.")
  if (ctx.replyBlocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
  const current = await ctx.connection.client.sessions.get({ sessionID: session.id })
  if (!sameSession(current, session)) throw new Error("Session identity changed. Close and reopen this control.")
  if (ctx.state.closed) throw new Error("Dashboard closed.")
  if (ctx.replyBlocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
  return current
}

export function remember(ctx: SessionContext, session: Session) {
  if (ctx.state.snapshot)
    ctx.state.snapshot.sessions = ctx.state.snapshot.sessions.map((item) =>
      sameSession(item, session) ? session : item,
    )
  if (ctx.state.inspected && sameSession(ctx.state.inspected, session)) ctx.state.inspected = session
  ctx.updateRecipient(session)
}

function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}
