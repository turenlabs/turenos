import { richContent } from "../markdown/normalize"
import { joinBlocks, pendingQuestions, transcriptBlocks } from "../messages"
import { continuesTurn } from "../messages/turns"
import type { DashboardState } from "../state"
import type { Conversation, LiveMessage, LivePage } from "./context"
import { markUnread } from "./follow"
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
          toolsExpanded: state.expandToolOutput,
          capped: false,
          expanded: false,
          cursor: state.detail?.cursor.next ?? undefined,
          boundary,
        }
  // Text depends on neighbours (turn headers and breaks) and on the tool-output preference, so a cached
  // entry is rebuilt from its message whenever either changes.
  if (cached.toolsExpanded !== state.expandToolOutput) {
    rebuild(cached, state.expandToolOutput)
    cached.toolsExpanded = state.expandToolOutput
  }
  const incoming = build(messages, before(cached.messages, messages[0]), state.expandToolOutput)
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
  // Server order. A refetched page replaces its cached entries in place; an older page is stale for any
  // message already cached, so the cached copy wins and only the unseen older messages go first.
  const have = new Set((older ? cached.messages : incoming).map((item) => item.id))
  cached.messages = older
    ? [...incoming.filter((item) => !have.has(item.id)), ...cached.messages]
    : [...cached.messages.filter((item) => !have.has(item.id)), ...incoming]
  // Older messages change how the first cached one reads: its header and turn break depend on what precedes it.
  if (older) rebuild(cached, state.expandToolOutput)
  let size = cached.messages.reduce((sum, item) => sum + Math.max(item.formatted.length, item.raw.length) + 2, 0)
  // Only older messages are evicted; the newest (the running reply) stays even when it alone exceeds the budget.
  while (cached.messages.length > 1 && (cached.messages.length > 120 || size > 80000)) {
    const removed = cached.messages.shift()!
    size -= Math.max(removed.formatted.length, removed.raw.length) + 2
    cached.capped = true
  }
  c.live.delete(id)
  c.live.set(id, cached)
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
    (visible && joinBlocks(shown(visible, cached?.expanded === true).map((item) => block(item, state.rawResponses)))) ||
    (boundary ? "Earlier history is outside this recent window. Press h to inspect history." : "No messages yet.")
  ui.renderContent(`${question ? `${question}\n\n` : ""}${staged}${notice}${content}`, !question)
  syncLayout(c)
  restorePosition(c)
  markUnread(c, content)
}

/** The last few messages, or all of them; a window that starts inside a turn is widened to the turn's first step. */
function shown(items: LiveMessage[], all: boolean) {
  const start = all ? 0 : Math.max(0, items.length - 6)
  const first = items.findLastIndex((item, index) => index <= start && !item.continued)
  return items.slice(Math.max(0, first))
}

function block(item: LiveMessage, raw: boolean) {
  const text = raw ? item.raw : item.formatted
  if (raw || richContent(text)) return { text, turn: item.turn && !raw }
  // A message past the rich budget degrades alone, as unhighlighted text under plain role labels.
  const fence = "`".repeat(Math.max(3, ...Array.from(item.raw.matchAll(/`+/g), (run) => run[0].length + 1)))
  return { text: `${fence}text\n${item.raw}\n${fence}`, turn: item.turn }
}

/** Rebuilds every cached message's text from the messages themselves. */
function rebuild(cached: LivePage, expanded: boolean) {
  cached.messages = build(
    cached.messages.map((item) => item.message),
    undefined,
    expanded,
  )
}

/** Every message's text in both views, with each one aware of the message before it. */
function build(messages: Messages, previous: Messages[number] | undefined, expanded: boolean): LiveMessage[] {
  const formatted = transcriptBlocks(messages, false, true, { expanded, previous })
  const raw = transcriptBlocks(messages, true, false, { previous })
  return messages.map((message, index) => ({
    id: message.id,
    message,
    formatted: formatted[index]!.text,
    raw: raw[index]!.text,
    turn: formatted[index]!.turn,
    continued: continuesTurn(message, index ? messages[index - 1] : previous),
  }))
}

/** The cached message just before `first`, when it is already cached. */
function before(cached: LiveMessage[], first: Messages[number] | undefined) {
  const index = cached.findIndex((item) => item.id === first?.id)
  return index > 0 ? cached[index - 1]!.message : undefined
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
