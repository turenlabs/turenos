import { matchesKey } from "../keys"
import { display } from "../messages"
import { recipient, selectedSession, type SessionActionsContext } from "./context"
import { updateSession } from "./update"

export function renameSession(ctx: SessionActionsContext): void {
  const session = selectedSession(ctx)
  if (!session) return
  const dialog = ctx.dialogs.open("Rename session", false, 19)
  if (!dialog) return
  recipient(ctx, dialog, session)
  const title = ctx.dialogs.input(dialog, "Title (1-200 characters)", display(session.title, 64000))
  title.maxLength = 200
  dialog.submit = () => updateSession(ctx, dialog, session, { title: title.value })
  dialog.error.content = "Enter / Ctrl+S save · Esc close"
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    void ctx.dialogs.submit()
    return true
  }
  title.focus()
}
