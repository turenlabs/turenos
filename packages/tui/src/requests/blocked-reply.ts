import { TextRenderable } from "@opentui/core"
import type { Session } from "../server"
import { display } from "../messages"
import { sessionTitle, type MessageDraft } from "../state"
import { color } from "../theme"
import { matchesKey } from "../keys"
import { owner, type RequestContext } from "./context"

/** The dialog shown instead of a reply editor for a task-owned subagent: it never sends a message. */
export function openBlockedReply(ctx: RequestContext, session: Session, reopen: () => void) {
  const sessionID = session.id
  const rootID = owner(ctx, sessionID)?.rootSessionID
  const target = rootID ?? session.parentID
  const dialog = ctx.dialogs.open("Task-owned subagent", false, 24)
  if (!dialog) return
  dialog.recipient = session
  const draft = ctx.messages.get(sessionID)
  const redirect = !!target && target !== sessionID
  // The reason comes first, so the button reads as the answer to it.
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: explanation(ctx, rootID ? "main" : "parent", target, draft),
      fg: color.text,
      wrapMode: "word",
    }),
  )
  if (redirect) dialog.form.add(openButton(ctx, rootID ? "main" : "parent"))
  dialog.error.content = redirect
    ? `Enter Open ${rootID ? "main" : "parent"} + reply · Esc close${draft ? "\nChild draft stays here; Ctrl+Y copies selected text." : ""}`
    : "Esc close · t Tasks"
  if (redirect) {
    dialog.submit = async () => {
      if (!ctx.state.connected) throw new Error("Reconnect before opening the owning session.")
      const current = await ctx.connection.client.sessions.get({ sessionID: target })
      if (!ctx.state.closed) ctx.openSession(current.id, false, current)
    }
    dialog.afterSubmit = () => {
      if (!ctx.state.closed && !ctx.state.modal && ctx.state.selected === target) reopen()
    }
    dialog.key = (key) => {
      if (!matchesKey(key, "enter")) return false
      void ctx.dialogs.submit()
      return true
    }
  }
  dialog.form.focus()
}

function openButton(ctx: RequestContext, kind: "main" | "parent") {
  return new TextRenderable(ctx.renderer, {
    content: `[ Open ${kind} session and reply ]`,
    fg: color.bg,
    bg: color.accent,
    wrapMode: "word",
    flexShrink: 0,
    onMouseDown: (event) => {
      event.preventDefault()
      if (event.button === 0) void ctx.dialogs.submit()
    },
  })
}

function explanation(ctx: RequestContext, kind: "main" | "parent", target: string | undefined, draft?: MessageDraft) {
  const guidance = target
    ? `Open its ${kind} session to give instructions instead.\nTarget: ${sessionTitle(ctx.state.snapshot?.sessions.find((item) => item.id === target)?.title ?? target, 200)}`
    : "Open Tasks (t) to locate the owning main session."
  const saved = draft ? `\n\nSaved child draft (not moved or sent):\n${display(draft.text, 32000)}` : ""
  return `This subagent is controlled by its owning task and cannot accept direct replies.\n\n${guidance}\n\nNo message will be sent.${saved}`
}
