import { pendingQuestions, transcript } from "../messages"
import type { DashboardState } from "../state"
import type { Conversation, LivePage } from "./context"
import { restorePosition, stagedMessageID } from "./position"

type Messages = NonNullable<DashboardState["detail"]>["messages"]

/** Folds newly fetched messages into the session's cached live window, trimming and evicting as needed. */
export function mergeLive(c: Conversation, messages: Messages, older = false) {
  const { state } = c
  const id = state.selected
  const boundary = stagedMessageID(c)
  const previous = c.live.get(id)
  const cached: LivePage =
    previous?.boundary === boundary && previous
      ? previous
      : {
          messages: [],
          capped: false,
          expanded: false,
          cursor: state.detail?.cursor.next ?? undefined,
          boundary,
        }
  const incoming = messages.map((message) => ({
    id: message.id,
    formatted: transcript([message]),
    raw: transcript([message], true),
  }))
  if (
    !older &&
    incoming.length &&
    cached.messages.length &&
    !incoming.some((item) => cached.messages.some((previous) => previous.id === item.id))
  ) {
    cached.messages = []
    cached.cursor = state.detail?.cursor.next ?? undefined
    cached.capped = false
    c.generation++
    c.hooks.say("Recent messages moved beyond cached history. Scroll up to reload; h opens full History.")
  }
  const merged = new Map(
    (older ? [...incoming, ...cached.messages] : [...cached.messages, ...incoming]).map((item) => [item.id, item]),
  )
  cached.messages = [...merged.values()]
  let size = cached.messages.reduce((sum, item) => sum + Math.max(item.formatted.length, item.raw.length) + 2, 0)
  while (cached.messages.length > 1 && (cached.messages.length > 120 || size > 80000)) {
    const removed = cached.messages.shift()!
    size -= Math.max(removed.formatted.length, removed.raw.length) + 2
    cached.capped = true
  }
  c.live.delete(id)
  c.live.set(id, cached)
  if (size > 80000) cached.capped = true
  if (c.live.size > 5) {
    const evicted = c.live.keys().next().value!
    c.live.delete(evicted)
    c.positions.delete(evicted)
  }
  return cached
}

export function drawLive(c: Conversation) {
  const { state, ui } = c
  const cached = c.live.get(state.selected)
  const question = c.hooks.questionsInPanel ? "" : pendingQuestions(state.detail?.questions ?? [])
  const notice = cached?.capped ? "Live scrollback limit reached. Press h, then [ for further history.\n\n" : ""
  const boundary = stagedMessageID(c)
  const point = boundary ? (cached?.messages.findIndex((message) => message.id === boundary) ?? -1) : -1
  const visible = boundary ? cached?.messages.slice(0, Math.max(0, point)) : cached?.messages
  const staged = boundary ? "UNDO STAGED - a new reply commits this point; /redo restores later turns.\n\n" : ""
  const content =
    visible
      ?.slice(cached?.expanded ? 0 : -6)
      .map((item) => (state.rawResponses ? item.raw : item.formatted))
      .join("\n\n") ||
    (boundary ? "Earlier history is outside this recent window. Press h to inspect history." : "No messages yet.")
  ui.renderContent(`${question ? `${question}\n\n` : ""}${staged}${notice}${content}`, !question)
  syncLayout(c)
  restorePosition(c)
}

/** Forces the scroll box to lay out now so the position restore measures the new content. */
export function syncLayout(c: Conversation) {
  const { ui } = c
  try {
    const root = (ui.root.parent ?? ui.root) as any
    if (typeof root?.calculateLayout === "function") {
      root.calculateLayout()
    } else if (typeof root?.getLayoutNode === "function") {
      root.getLayoutNode()?.calculateLayout(root.width ?? 80, root.height ?? 24, 1)
    }
    const detail = ui.detail as any
    if (detail) {
      detail._lastLayoutFrame = -1
      detail.updateFromLayout?.()
      if (detail.content) {
        detail.content._lastLayoutFrame = -1
        detail.content.updateFromLayout?.()
      }
      if (detail.viewport) {
        detail.viewport._lastLayoutFrame = -1
        detail.viewport.updateFromLayout?.()
      }
      detail.recalculateBarProps?.()
    }
  } catch {
    // Safe fallback: layout will sync on next frame render
  }
}
