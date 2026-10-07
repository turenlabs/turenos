import { TextBufferRenderable, type Renderable } from "@opentui/core"
import type { Conversation } from "./context"
import { clearUnread, syncScrolledCue } from "./follow"

export function atBottom(c: Conversation) {
  return c.ui.detail.scrollTop + c.ui.detail.viewport.height >= c.ui.detail.scrollHeight - 1
}

export function stagedMessageID(c: Conversation) {
  return c.state.snapshot?.sessions.find((session) => session.id === c.state.selected)?.revert?.messageID
}

export function commitPrepend(c: Conversation) {
  if (!c.prepend) return
  if (c.position) c.position.scroll = c.ui.detail.scrollTop
  c.prepend = undefined
}

export function currentView(c: Conversation) {
  const key = `${c.state.tab}:${c.state.selected}:${c.state.history}:${stagedMessageID(c) ?? ""}`
  if (key !== c.viewKey) {
    c.viewKey = key
    c.generation++
    c.prepend = undefined
    c.textAnchor = undefined
  }
  return c.generation
}

export function rememberPosition(c: Conversation) {
  const { state, ui } = c
  if (state.tab !== "sessions" || !state.selected || state.modal?.inline) return
  if (state.detail?.sessionID !== state.selected) return
  const saved = c.positions.get(state.selected) ?? { history: state.history, latest: 0, transcript: 0 }
  saved.history = state.history
  if (state.history) saved.cursor = state.historyCursor
  saved[state.history ? "transcript" : "latest"] = c.prepend
    ? ui.detail.scrollTop
    : (c.position?.scroll ?? ui.detail.scrollTop)
  c.positions.delete(state.selected)
  c.positions.set(state.selected, saved)
  if (c.positions.size > 256) c.positions.delete(c.positions.keys().next().value!)
}

export function restorePosition(c: Conversation) {
  const { state, ui, position } = c
  if (
    state.closed ||
    !position ||
    state.tab !== "sessions" ||
    state.selected !== position.sessionID ||
    state.history !== position.history ||
    (state.detail && state.detail.sessionID !== position.sessionID) ||
    state.modal?.inline
  )
    return
  // Markdown may report several intermediate heights while rebuilding blocks.
  // Reapply the prefix delta until the next input or poll commits the anchor.
  ui.detail.scrollTo(
    c.prepend ? Math.max(0, c.prepend.scroll + ui.detail.scrollHeight - c.prepend.height) : position.scroll,
  )
}

/**
 * Keeps a logical text location from the last painted frame. Native lineInfo
 * handles word wrapping, tabs and wide characters; numeric offsets cannot.
 * Returns the renderAfter it replaced so dispose can put it back.
 */
export function installTextAnchor(c: Conversation) {
  const { state, ui } = c
  const renderAfter = ui.detail.renderAfter
  ui.detail.renderAfter = function (buffer, delta) {
    renderAfter?.call(this, buffer, delta)
    if (c.unread && atBottom(c)) clearUnread(c)
    syncScrolledCue(c)
    if (state.tab !== "sessions" || state.modal?.inline || state.detail?.sessionID !== state.selected) {
      c.textAnchor = undefined
      return
    }
    if (reflowed(c)) return
    c.textAnchor = undefined
    if (c.position?.scroll === Number.MAX_SAFE_INTEGER || atBottom(c)) return
    captureAnchor(c, ui.detail.content)
  }
  return renderAfter
}

/** Re-pins the reading position when the anchored text moved because the width changed. */
function reflowed(c: Conversation) {
  const { state, ui } = c
  const anchor = c.textAnchor
  if (!anchor || anchor.node.isDestroyed || anchor.node.width === anchor.width) return false
  const info = anchor.node.lineInfo
  let line = -1
  for (let i = 0; i < info.lineSources.length; i++) {
    if (info.lineSources[i] === anchor.source && info.lineStartCols[i]! <= anchor.column) line = i
  }
  c.textAnchor = undefined
  if (line < 0 || c.position?.scroll === Number.MAX_SAFE_INTEGER) return false
  const scroll = ui.detail.scrollTop + anchor.node.y + line - ui.detail.viewport.y - anchor.row
  c.prepend = undefined
  c.position = { sessionID: state.selected, history: state.history, scroll: Math.max(0, scroll) }
  restorePosition(c)
  return true
}

function captureAnchor(c: Conversation, node: Renderable): boolean {
  const { viewport } = c.ui.detail
  if (!node.visible) return false
  if (node instanceof TextBufferRenderable && node.y + node.height > viewport.y) {
    const line = Math.max(0, viewport.y - node.y)
    const info = node.lineInfo
    if (info.lineSources[line] !== undefined && node.y + line < viewport.y + viewport.height) {
      c.textAnchor = {
        node,
        width: node.width,
        source: info.lineSources[line]!,
        column: info.lineStartCols[line]!,
        row: node.y + line - viewport.y,
      }
      return true
    }
  }
  return node.getChildren().some((child) => captureAnchor(c, child))
}
