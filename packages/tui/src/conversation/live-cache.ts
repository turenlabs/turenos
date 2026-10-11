import { RootRenderable } from "@opentui/core"
import { richContent } from "../markdown/normalize"
import { joinBlocks, pendingQuestions, transcriptBlock } from "../messages"
import { interruptedLine } from "../messages/failure"
import { fenceFor } from "../messages/literal"
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
  const incoming = build(messages, before(cached.messages, messages[0]), state.expandToolOutput, cached.messages)
  const cachedIDs = new Set(cached.messages.map((item) => item.id))
  if (!older && incoming.length && cached.messages.length && !incoming.some((item) => cachedIDs.has(item.id))) {
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
  // A partial page can finish a turn whose header is in the retained window.
  rebuild(cached, state.expandToolOutput, true)
  let size = cached.messages.reduce((sum, item) => sum + Math.max(item.formatted.length, item.raw.length) + 2, 0)
  // Only older messages are evicted; the newest (the running reply) stays even when it alone exceeds the budget.
  while (cached.messages.length > 1 && (cached.messages.length > 120 || size > 80000)) {
    const removed = cached.messages.shift()!
    size -= Math.max(removed.formatted.length, removed.raw.length) + 2
    cached.capped = true
  }
  // The message after an evicted one was built to continue it; it now opens the cache, so it needs its own header.
  if (cached.messages[0]?.continued)
    rebuild(cached, state.expandToolOutput, true)
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
  // A turn with no recorded finish that is no longer running ended early, e.g. when the server restarted.
  const ended =
    visible && !Object.hasOwn(state.snapshot?.active ?? {}, state.selected)
      ? interruptedLine(
          visible.map((item) => item.message),
          true,
        )
      : ""
  const content =
    (visible &&
      joinBlocks([
        ...shown(visible, cached?.expanded === true).map((item) => block(item, state.rawResponses)),
        ...(ended ? [{ text: ended, turn: false }] : []),
      ])) ||
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
  const fence = fenceFor(item.raw)
  return { text: `${fence}text\n${item.raw}\n${fence}`, turn: item.turn }
}

/** Rebuilds the cached messages' text from the messages themselves; `keep` reuses text whose sources did not change. */
function rebuild(cached: LivePage, expanded: boolean, keep = false) {
  cached.messages = build(
    cached.messages.map((item) => item.message),
    undefined,
    expanded,
    keep ? cached.messages : [],
  )
}

/**
 * Every message's text in both views, with each one aware of the message before it. A live paint changes only
 * the running message, so an entry of `known` is reused when the messages its text was built from are the same.
 */
function build(
  messages: Messages,
  previous: Messages[number] | undefined,
  expanded: boolean,
  known: readonly LiveMessage[] = [],
): LiveMessage[] {
  const reusable = new Map(known.map((item) => [item.id, item]))
  return messages.map((message, index) => {
    const sources = sourcesOf(messages, index, previous)
    const kept = reusable.get(message.id)
    if (kept && kept.sources.length === sources.length && kept.sources.every((item, at) => item === sources[at]))
      return kept
    const formatted = transcriptBlock(messages, index, false, true, { expanded, previous })
    return {
      id: message.id,
      message,
      formatted: formatted.text,
      raw: transcriptBlock(messages, index, true, false, { previous }).text,
      turn: formatted.turn,
      continued: continuesTurn(message, sources[0] as Messages[number] | undefined),
      sources,
    }
  })
}

/** What `messages[index]` reads from: the message before it, itself, and, when it heads a turn, the turn's later steps. */
function sourcesOf(messages: Messages, index: number, previous: Messages[number] | undefined) {
  const before = index ? messages[index - 1] : previous
  const sources: unknown[] = [before, messages[index]]
  if (continuesTurn(messages[index], before)) return sources
  for (let next = index + 1; continuesTurn(messages[next], messages[next - 1]); next++) sources.push(messages[next])
  return sources
}

/** The cached message just before `first`, when it is already cached. */
function before(cached: LiveMessage[], first: Messages[number] | undefined) {
  const index = cached.findIndex((item) => item.id === first?.id)
  return index > 0 ? cached[index - 1]!.message : undefined
}

/** The OpenTUI layout internals `syncLayout` resets so a second layout pass in one frame is not skipped. */
type Stale = { _lastLayoutFrame: number; updateFromLayout(): void }
type StaleScroll = Stale & { recalculateBarProps(): void; content: Stale; viewport: Stale }

/** Forces the scroll box to lay out now so the position restore measures the new content. */
export function syncLayout(c: Conversation) {
  const { ui } = c
  try {
    const root = ui.root.parent ?? ui.root
    if (root instanceof RootRenderable) root.calculateLayout()
    // OpenTUI offers no public way to lay a node out twice in a frame, so its frame guard is cleared directly.
    const detail = ui.detail as unknown as StaleScroll
    for (const node of [detail, detail.content, detail.viewport]) {
      node._lastLayoutFrame = -1
      node.updateFromLayout()
    }
    detail.recalculateBarProps()
  } catch {
    // Safe fallback: layout will sync on next frame render
  }
}
