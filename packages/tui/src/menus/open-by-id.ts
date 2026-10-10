import { identifier } from "../response-validation"
import { matchesKey } from "../keys"
import type { MenuContext } from "./context"

/** `back` reopens the menu that led here, so Esc returns to it instead of the dashboard. */
export function openByID(ctx: MenuContext, value = "", back?: () => void) {
  const dialog = ctx.dialogs.open("Open session by ID", false, 17)
  if (!dialog) return
  const input = ctx.dialogs.input(dialog, "Session ID (including older sessions)", value, "ses_...")
  input.maxLength = 256
  dialog.submit = async () => {
    const id = input.value.trim()
    try {
      identifier(id, "ses_")
    } catch {
      throw new Error("Enter a valid session ID beginning with ses_. Find it in web session details or a saved link.")
    }
    if (!ctx.state.connected) throw new Error("Reconnect before looking up a session.")
    const session = await ctx.connection.client.sessions.get({ sessionID: id })
    if (ctx.state.closed) return
    ctx.actions.openSession(session.id, false, session)
  }
  dialog.back = back
  dialog.error.content = `Enter / Ctrl+S open · Esc ${back ? "back" : "close"}\nLooks up this ID on the connected server.`
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    void ctx.dialogs.submit()
    return true
  }
  input.focus()
}
