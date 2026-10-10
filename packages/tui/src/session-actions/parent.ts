import { TextRenderable } from "@opentui/core"
import { label } from "../state"
import { color } from "../theme"
import { recipient, selectedSession, type SessionActionsContext } from "./context"
import { openSessionById } from "./update"

export function openParentSession(ctx: SessionActionsContext): void {
  const session = selectedSession(ctx)
  if (!session) return
  const id = session.parentID
  if (!id) return ctx.say("This session has no parent session.")
  const dialog = ctx.dialogs.open("Open parent session", false, 17)
  if (!dialog) return
  recipient(ctx, dialog, session)
  dialog.form.add(new TextRenderable(ctx.renderer, { content: `Parent: ${label(id, 256)}`, fg: color.text }))
  dialog.submit = () => openSessionById(ctx, id)
  void ctx.dialogs.submit()
}
