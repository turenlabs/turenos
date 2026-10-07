import { TextRenderable } from "@opentui/core"
import { sessionTitle } from "../state"
import { color } from "../theme"
import { currentSession, openControl, type SessionContext } from "./session"

export function compact(ctx: SessionContext) {
  const target = openControl(ctx, "Compact session?")
  if (!target) return
  const { session, dialog } = target
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content:
        "Ask the server to summarize this conversation into a smaller context for future turns.\n\nThis may call the session's model. Busy work is never interrupted automatically; the server can refuse compaction.\n\nYour transcript view and saved reply stay in place. No reply is sent.",
      fg: color.text,
      wrapMode: "word",
    }),
  )
  dialog.error.content = "Ctrl+S confirm server summarization\nEsc cancel"
  dialog.submit = async () => {
    await currentSession(ctx, session)
    if (ctx.state.modal !== dialog) throw new Error("Confirmation is no longer open.")
    await ctx.connection.client.sessions.compact({ sessionID: session.id })
    if (!ctx.state.closed) ctx.say(`Compacted ${sessionTitle(session.title || session.id, 80)}. Server summary complete.`)
  }
  dialog.form.focus()
}
