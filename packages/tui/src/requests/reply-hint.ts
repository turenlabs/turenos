import { layout } from "../theme"

type Waiting = "permission" | "question" | undefined

export type ReplyFacts = {
  live: boolean
  queue: boolean
  waiting: Waiting
  /** An empty editor's Enter opens the waiting request instead of sending. */
  review: boolean
  revert: boolean
  queued: number
  /** The title of the session this reply goes to when it is not the one in view. */
  elsewhere?: string
  draft: boolean
  listed: boolean
}

/** The row above the editor. It exists only when it carries news, so an idle reply has no heading. */
export function replyHeading(facts: ReplyFacts) {
  const mode = !facts.live ? "Send" : facts.queue ? "Queue" : "Steer"
  if (facts.waiting)
    return `${mode} · ${facts.waiting === "permission" ? "Permission" : "Question"} waiting${facts.review ? "" : " · Esc then Enter to answer"}`
  const parts = [
    ...(facts.live
      ? [mode, facts.queue ? "sent when the agent is idle · Ctrl+T steer" : "agent is working · Ctrl+T queue"]
      : []),
    ...(facts.elsewhere ? [`Reply to ${facts.elsewhere}`] : []),
    ...(facts.revert ? ["undo staged"] : []),
    ...(facts.queued ? [`${facts.queued} queued`] : []),
  ]
  if (!parts.length) return ""
  return facts.live ? parts.join(" · ") : [mode, ...parts].join(" · ")
}

/** The one hint row: the next likely action first, whole entries dropped from the end until it fits `room`. */
export function replyHint(facts: ReplyFacts, room: number) {
  if (facts.listed) return "↑↓ choose · Tab complete · Enter pick · Esc close"
  const enter = facts.review
    ? `Enter ${facts.waiting === "permission" ? "reviews the permission" : "answers the question"}`
    : facts.revert
      ? "Enter send + commit undo"
      : "Enter send"
  const entries = [
    enter,
    facts.review && facts.live ? "Esc Esc stops the turn" : "Esc shortcuts",
    ...(facts.draft ? ["F4 discard"] : []),
  ]
  const fits = entries.map((_, index) => entries.slice(0, entries.length - index).join(" · ")).find((text) => text.length <= room)
  return fits ?? entries[0]!
}

/** The editor's placeholder; the slash, file and shell tips stay in help below the wide breakpoint. */
export function replyPlaceholder(width: number) {
  return width >= layout.wideBreakpoint ? "Message… / commands · @ files · ! shell" : "Message…"
}
