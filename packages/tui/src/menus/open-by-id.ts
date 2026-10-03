import { identifier } from "../response-validation"
import { matchesKey } from "../keys"
import type { MenuContext } from "./context"

export function openByID(ctx: MenuContext, value = "") {
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
  dialog.error.content = "Ctrl+S / Enter Open · Esc cancel\nLooks up this ID on the connected server."
  dialog.key = (key) => {
    if (!matchesKey(key, "enter")) return false
    void ctx.dialogs.submit()
    return true
  }
  input.focus()
}
