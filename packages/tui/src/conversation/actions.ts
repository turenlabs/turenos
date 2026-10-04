import type { MessagesListOutput } from "@turenlabs/client"
import type { Conversation } from "./context"
import { sentByReader } from "./follow"
import { drawLive, mergeLive } from "./live-cache"
import { render } from "./load"
import { commitPrepend, currentView, rememberPosition, stagedMessageID } from "./position"

export function loadPosition(c: Conversation) {
  const { state, ui } = c
  c.generation++
  c.textAnchor = undefined
  c.prepend = undefined
  c.pageRequest = undefined
  c.beforeQuestion = undefined
  c.drawn = ""
  c.unread = false
  if (state.detail && state.detail.sessionID !== state.selected) state.detail = undefined
  const saved = c.positions.get(state.selected)
  state.history = saved?.history ?? false
  state.historyCursor = saved?.cursor
  c.position = {
    sessionID: state.selected,
    history: state.history,
    scroll: saved?.[state.history ? "transcript" : "latest"] ?? Number.MAX_SAFE_INTEGER,
  }
  if (!state.history && c.live.has(state.selected)) {
    drawLive(c)
  } else {
    ui.detail.scrollTo(0)
  }
}

export function toggleHistory(c: Conversation) {
  const { state, ui } = c
  if (state.tab !== "sessions" || !state.selected) return c.hooks.say("Select a session first.")
  rememberPosition(c)
  c.pageRequest = undefined
  c.drawn = ""
  c.unread = false
  state.history = !state.history
  currentView(c)
  state.detail = undefined
  c.position = {
    sessionID: state.selected,
    history: state.history,
    scroll: c.positions.get(state.selected)?.[state.history ? "transcript" : "latest"] ?? 0,
  }
  state.historyCursor = state.history ? c.positions.get(state.selected)?.cursor : undefined
  ui.detail.scrollTo(0)
  c.hooks.actions()
  void render(c)
}

export function updateLive(c: Conversation, messages: MessagesListOutput["data"]) {
  const { state, ui } = c
  if (
    state.closed ||
    state.tab !== "sessions" ||
    state.history ||
    state.modal?.inline ||
    state.detail?.sessionID !== state.selected ||
    stagedMessageID(c)
  )
    return
  commitPrepend(c)
  const follow =
    (!state.detail.questions.length || c.hooks.questionsInPanel) &&
    (sentByReader(c, messages) ||
      c.position?.scroll === Number.MAX_SAFE_INTEGER ||
      (!c.position && ui.detail.scrollTop + ui.detail.viewport.height >= ui.detail.scrollHeight - 1))
  if (follow) c.position = { sessionID: state.selected, history: false, scroll: Number.MAX_SAFE_INTEGER }
  state.detail.messages = [...messages]
  mergeLive(c, state.detail.messages)
  drawLive(c)
  c.hooks.actions()
}

export function invalidateSession(c: Conversation, sessionID: string) {
  const { state } = c
  c.live.delete(sessionID)
  c.positions.delete(sessionID)
  if (state.selected !== sessionID) return
  ++state.detailVersion
  ++c.generation
  c.textAnchor = undefined
  state.detail = undefined
  state.historyCursor = undefined
  c.pageRequest = undefined
  c.position = undefined
  c.prepend = undefined
  c.beforeQuestion = undefined
  c.ui.renderContent("Refreshing conversation history…")
}

export function invalidateAll(c: Conversation) {
  c.live.clear()
  c.positions.clear()
  if (c.state.selected) invalidateSession(c, c.state.selected)
}

export function page(c: Conversation, direction: "next" | "previous") {
  const { state } = c
  if (
    c.pageRequest ||
    state.modal ||
    state.tab !== "sessions" ||
    !state.history ||
    state.detail?.sessionID !== state.selected
  )
    return
  const cursor = state.detail.cursor[direction]
  if (!cursor) return c.hooks.say(direction === "next" ? "Start of history reached." : "Newest history page.")
  c.pageRequest = { sessionID: state.selected, cursor, direction }
  c.hooks.say("Loading history page…")
  void render(c)
}
