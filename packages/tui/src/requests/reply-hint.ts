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

/**
 * The row above the editor. It exists only when it carries news, so an idle reply has no heading. Whole parts
 * give way to `room` (the long descriptions shorten first, then trailing parts go), so the row is never cut
 * in the middle of a phrase.
 */
export function replyHeading(facts: ReplyFacts, room = Infinity) {
  const mode = !facts.live ? "Send" : facts.queue ? "Queue" : "Steer"
  if (facts.waiting) return `${mode} · ${facts.waiting} waiting`
  const tail = [
    ...(facts.elsewhere ? [`Reply to ${facts.elsewhere}`] : []),
    ...(facts.revert ? ["undo staged"] : []),
    ...(facts.queued ? [`${facts.queued} queued`] : []),
  ]
  const states = facts.queue
    ? ["sent when the agent is idle · Ctrl+T steer", "sent when idle"]
    : ["agent is working · Ctrl+T queue", "agent is working"]
  // The news in `tail` outlasts the long description of the mode.
  const forms = Array.from({ length: tail.length + 1 }, (_, index) => tail.slice(0, tail.length - index)).flatMap(
    (kept) => (facts.live ? states : [""]).map((state) => [mode, ...(state ? [state] : []), ...kept]),
  )
  const fits = forms.map((parts) => parts.join(" · ")).find((text) => text.length <= room)
  const text = fits ?? mode
  return facts.live || tail.length ? text : ""
}

/** The one hint row: the next likely action first, whole entries dropped from the end until it fits `room`. */
export function replyHint(facts: ReplyFacts, room: number) {
  if (facts.listed) {
    const forms = ["↑↓ choose · Tab complete · Enter pick · Esc close", "↑↓ · Tab complete · Enter pick · Esc close"]
    return forms.find((text) => text.length <= room) ?? "Tab complete · Enter pick · Esc close"
  }
  const enter = facts.review
    ? `Enter ${facts.waiting === "permission" ? "reviews the permission" : "answers the question"}`
    : facts.revert
      ? "Enter send + commit undo"
      : "Enter send"
  const entries = [
    enter,
    facts.review && facts.live ? "Esc Esc stops the turn" : facts.waiting ? "Esc then Enter answers" : "Esc shortcuts",
    ...(facts.draft ? ["F4 discard"] : []),
  ]
  const fits = entries.map((_, index) => entries.slice(0, entries.length - index).join(" · ")).find((text) => text.length <= room)
  return fits ?? entries[0]!
}

/** The editor's placeholder; the slash, file and shell tips stay in help below the wide breakpoint. */
export function replyPlaceholder(width: number) {
  return width >= layout.wideBreakpoint ? "Message… / commands · @ files · ! shell" : "Message…"
}
