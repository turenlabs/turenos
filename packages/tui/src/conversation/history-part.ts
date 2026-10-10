import { joinBlocks, pendingQuestions, transcriptBlocks } from "../messages"
import { interruptedLine } from "../messages/failure"
import type { DashboardState } from "../state"
import type { Conversation, HistoryPart } from "./context"
import { restorePosition, stagedMessageID } from "./position"
import { syncLayout } from "./live-cache"

type Detail = NonNullable<DashboardState["detail"]>

// One painted part holds at most this much text, as the rendered transcript always has; a longer page is
// read in several parts rather than cut. A message's block joins its neighbour with at most this much.
const BUDGET = 80000
const SEPARATOR = 7

/** A new page opens at its newest part when read going older and at its oldest part when read going newer. */
export function openPart(c: Conversation, direction: "next" | "previous") {
  c.part = {
    key: partKey(c),
    pin: direction === "next" ? { edge: "end" } : { edge: "start", at: 0 },
    sizes: [],
    start: 0,
    end: 0,
  }
}

/**
 * Moves to the neighbouring part of the History page on screen when it has one, so a page the size cap
 * split can be read in full before the next page is fetched. Reports whether it moved.
 */
export function movePart(c: Conversation, direction: "next" | "previous") {
  const { state, ui } = c
  const part = c.part?.key === partKey(c) ? c.part : undefined
  if (!part || !state.detail) return false
  const older = direction === "next"
  if (older ? part.start <= 0 : part.end >= part.sizes.length) return false
  part.pin = older ? { edge: "end", at: part.start } : { edge: "start", at: part.end }
  // Reading older, the eye continues from the bottom of what was just revealed.
  c.position = { sessionID: state.selected, history: true, scroll: older ? Number.MAX_SAFE_INTEGER : 0 }
  c.prepend = undefined
  c.textAnchor = undefined
  paintHistory(c, state.detail, c.hooks.questionsInPanel ? "" : pendingQuestions(state.detail.questions))
  ui.detail.scrollTo(older ? Number.MAX_SAFE_INTEGER : 0)
  return true
}

/** Paints the History page: its newest messages that fit, or the part a move chose. */
export function paintHistory(c: Conversation, result: Detail, questionPreview: string) {
  const { state, ui } = c
  const blocks = transcriptBlocks(result.messages, state.rawResponses, true, { expanded: state.expandToolOutput })
  const part = layout(c, blocks.map((block) => block.text.length + SEPARATOR))
  // The newest page ends where the session does; a turn the server never finished says so there.
  const active = Object.hasOwn(state.snapshot?.active ?? {}, state.selected)
  const ended =
    !state.historyCursor && !active && part.end === blocks.length
      ? interruptedLine(result.messages, !state.rawResponses)
      : ""
  const content =
    [
      hiddenNote(part.start, "earlier", "["),
      joinBlocks(blocks.slice(part.start, part.end)),
      hiddenNote(part.sizes.length - part.end, "later", "]"),
      ended,
    ]
      .filter(Boolean)
      .join("\n\n") || "No messages yet."
  const staged = stagedMessageID(c) ? "UNDO STAGED - this History view includes later, staged-away messages.\n\n" : ""
  ui.renderContent(`${questionPreview ? `${questionPreview}\n\n` : ""}${staged}${content}`, !questionPreview)
  syncLayout(c)
  restorePosition(c)
}

function hiddenNote(count: number, which: "earlier" | "later", key: "[" | "]") {
  if (!count) return ""
  const one = count === 1
  return `${count} ${which} message${one ? "" : "s"} on this page ${one ? "is" : "are"} not shown yet. Press ${key} to read ${one ? "it" : "them"}.`
}

function partKey(c: Conversation) {
  return `${c.state.selected}:${c.state.historyCursor ?? ""}`
}

/** Fits the part to the pinned edge: as many whole messages as the budget holds, and at least one. */
function layout(c: Conversation, sizes: number[]): HistoryPart {
  const key = partKey(c)
  if (c.part?.key !== key) openPart(c, "next")
  const part = c.part!
  const length = sizes.length
  part.sizes = sizes
  if (part.pin.edge === "start") {
    part.start = Math.max(0, Math.min(part.pin.at ?? 0, length - 1))
    part.end = Math.min(length, part.start + count(sizes, part.start, 1))
    return part
  }
  part.end = Math.min(part.pin.at ?? length, length)
  part.start = Math.max(0, part.end - count(sizes, part.end - 1, -1))
  return part
}

/** How many messages from `from`, walking by `step`, fit the budget. */
function count(sizes: number[], from: number, step: 1 | -1) {
  let used = 0
  let taken = 0
  for (let index = from; index >= 0 && index < sizes.length; index += step) {
    if (taken && used + sizes[index]! > BUDGET) break
    used += sizes[index]!
    taken++
  }
  return taken
}
