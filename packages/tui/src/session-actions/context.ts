import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import type { Connection, Session } from "../server"
import { label, type DashboardState, type ModalState } from "../state"
import { color } from "../theme"

export type SessionActionsContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
  openSession: (id: string, inspect?: boolean, session?: Session) => void
  onUpdate: (session: Session) => void
  onDelete: (sessionID: string) => void
}

export function selectedSession(ctx: SessionActionsContext) {
  const session =
    ctx.state.tab === "sessions"
      ? ctx.state.snapshot?.sessions.find((item) => item.id === ctx.state.selected)
      : undefined
  if (!session) ctx.say("Select an available session first.")
  return session
}

/** Pins the session a dialog acts on, so a refresh cannot retarget the request. */
export function recipient(ctx: SessionActionsContext, dialog: ModalState, session: Session) {
  dialog.recipient = session
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${label(session.title)}\n${label(session.id, 256)}\n${label(session.location.directory, 4096)}`,
      fg: color.muted,
      wrapMode: "word",
    }),
  )
}
