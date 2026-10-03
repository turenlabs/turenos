import type { Session } from "../server"
import { display } from "../messages"
import { maxDrafts, maxMessageLength, newMessageID, type RequestContext } from "./context"

/** Why `text` cannot become the session's reply draft, or nothing when it can. */
export function restoreBlocker(ctx: RequestContext, sessionID: string, text: string) {
  const previous = ctx.messages.get(sessionID)
  if (!text.trim()) return "The message is empty."
  if (text.length > maxMessageLength) return "The message is longer than the reply editor's 32,000 characters."
  if (previous?.submitted !== undefined || previous?.text.trim())
    return "Send or discard your reply draft first; it would be replaced."
  if (!previous && ctx.messages.size >= maxDrafts) return "16 message drafts are saved. Send or discard one first."
  return undefined
}

export function restoreDraft(ctx: RequestContext, session: Session, messageID: string, text: string) {
  if (restoreBlocker(ctx, session.id, text)) return false
  ctx.messages.set(session.id, {
    text: display(text, maxMessageLength),
    id: newMessageID(),
    recipient: session,
    delivery: "steer",
    restoredFrom: messageID,
  })
  return true
}

export function clearRestoredDraft(ctx: RequestContext, sessionID: string, messageID: string, text: string) {
  const draft = ctx.messages.get(sessionID)
  if (
    draft?.restoredFrom === messageID &&
    draft.submitted === undefined &&
    draft.text === display(text, maxMessageLength)
  )
    ctx.messages.delete(sessionID)
}

/** Adds text, such as an @file mention, to the end of the session's reply draft. */
export function mention(ctx: RequestContext, session: Session, text: string) {
  const draft = ctx.messages.get(session.id)
  if (draft?.submitted !== undefined || (!draft && ctx.messages.size >= maxDrafts)) return false
  if (!draft) {
    ctx.messages.set(session.id, { text, id: newMessageID(), recipient: session, delivery: "steer" })
    return true
  }
  const next = `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${text}`
  if (next.length > maxMessageLength) return false
  draft.text = next
  draft.cursor = next.length
  return true
}
