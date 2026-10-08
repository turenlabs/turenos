import { TextRenderable } from "@opentui/core"
import { requireWord } from "../dialogs/fields"
import { color } from "../theme"
import { announceOpen, recipient, selectedSession, type SessionActionsContext } from "./context"
import { updateSession } from "./update"

export function archiveSession(ctx: SessionActionsContext): void {
  const session = selectedSession(ctx)
  if (!session) return
  const restore = session.time.archived !== undefined
  const action = restore ? "restore" : "archive"
  const dialog = ctx.dialogs.open(restore ? "Restore session" : "Archive session", false, 23)
  if (!dialog) return
  recipient(ctx, dialog, session)
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: restore
        ? "Restoring returns the session to the recent lists.\nTask-owned sessions may reject this change."
        : "Archiving hides recent history; it does not interrupt running work.\nTask-owned sessions may reject this change.",
      fg: color.text,
      wrapMode: "word",
    }),
  )
  const confirmation = ctx.dialogs.input(dialog, `Confirmation (type ${action})`)
  // Capture once for this confirmation, not on each ambiguous-failure retry.
  const archived = restore ? null : Date.now()
  dialog.submit = async () => {
    await updateSession(ctx, dialog, session, { archived })
  }
  if (!restore) announceOpen(ctx, dialog, session, "Session archived. Running work was not interrupted.")
  dialog.error.content = `Ctrl+S ${action} · Esc cancel`
  requireWord(dialog, confirmation, action, ctx.dialogs.resize)
  confirmation.focus()
}
