import { TextRenderable } from "@opentui/core"
import { requireWord } from "../dialogs/fields"
import { color } from "../theme"
import { announceOpen, recipient, selectedSession, type SessionActionsContext } from "./context"

export function deleteSession(ctx: SessionActionsContext): void {
  const session = selectedSession(ctx)
  if (!session) return
  const dialog = ctx.dialogs.open("Delete session", false, 23)
  if (!dialog) return
  recipient(ctx, dialog, session)
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content:
        "Deletes this session and all of its subagent sessions from the server. Running work is stopped first.\nThis cannot be undone; archive instead to keep the history.",
      fg: color.error,
      wrapMode: "word",
    }),
  )
  const confirmation = ctx.dialogs.input(dialog, "Confirmation (type delete)")
  dialog.submit = async () => {
    if (!ctx.state.connected) throw new Error("Reconnect before deleting a session.")
    await ctx.connection.deleteSession(session)
    if (ctx.state.closed) return
    ctx.onDelete(session.id)
    ctx.say("Session deleted.")
  }
  announceOpen(ctx, dialog, session, "Session deleted.")
  dialog.error.content = "Ctrl+S delete · Esc cancel"
  requireWord(dialog, confirmation, "delete", ctx.dialogs.resize)
  confirmation.focus()
}
