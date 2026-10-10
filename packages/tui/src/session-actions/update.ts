import { identifier } from "../response-validation"
import type { ModalState } from "../state"
import type { Session } from "../server"
import type { SessionActionsContext } from "./context"

/** Applies a rename, archive or restore to the pinned session and reconciles the dashboard with the result. */
export async function updateSession(
  ctx: SessionActionsContext,
  dialog: ModalState,
  session: Session,
  change: { title: string } | { archived: number | null },
) {
  const { state } = ctx
  if (!state.connected) throw new Error("Reconnect before changing a session.")
  const updated = await ctx.connection.updateSession(session, change)
  if (state.closed) return
  ctx.onUpdate(updated)
  dialog.recipient = updated
  if (state.snapshot)
    state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === updated.id ? updated : item))
  if (state.inspected?.id === updated.id) state.inspected = updated
  if ("archived" in change && change.archived !== null) {
    // Drop the inspection pin. Main's refresh must retain saved-draft recipients using fresh session pins.
    if (state.inspected?.id === updated.id) state.inspected = undefined
    if (state.inspection === updated.id) {
      state.inspection = ""
      state.query = ""
    }
    ctx.say("Session archived. Running work was not interrupted.")
    return
  }
  ctx.openSession(updated.id, false, updated)
  ctx.say("title" in change ? "Session renamed." : "Session restored.")
}

export async function openSessionById(ctx: SessionActionsContext, id: string) {
  identifier(id, "ses_")
  if (!ctx.state.connected) throw new Error("Reconnect before opening a session.")
  const session = await ctx.connection.client.sessions.get({ sessionID: id })
  if (!ctx.state.closed) ctx.openSession(session.id, false, session)
}
