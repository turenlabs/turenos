import { errorText, type Session } from "../server"
import type { Tab } from "../state"
import { label } from "../state"
import { renderList } from "./list"
import { resize } from "./status"
import type { DashboardContext } from "./context"

export function changeTab(d: DashboardContext, tab: Tab) {
  const state = d.state
  d.run.quitArmedUntil = 0
  if (state.searching || !d.c.dialogs.navigate()) return
  d.c.conversation.rememberPosition()
  d.run.views.set(state.tab, { selected: state.selected, query: state.query })
  state.tab = tab
  // A notice about the tab being left (for example "Terminal closed.") would read as news about this one.
  d.say("")
  state.selected = d.run.views.get(tab)?.selected ?? ""
  state.detail = undefined
  state.history = false
  ++state.detailVersion
  state.query = d.run.views.get(tab)?.query ?? ""
  d.ui.detail.scrollTo(0)
  renderList(d)
  if (tab === "sessions") d.c.conversation.loadPosition()
  if (tab !== "sessions") d.c.conversation.cancelPosition()
  void d.c.conversation.render()
  if (tab === "team") void d.c.team.sync()
}

/** Selects a session, fetching it first when the snapshot lacks it; `inspect` pins it as an attempted session. */
export function openSession(d: DashboardContext, id: string, inspect = false, session?: Session) {
  const state = d.state
  d.run.quitArmedUntil = 0
  if (state.closed) return
  if (!inspect && !session && !state.snapshot?.sessions.some((item) => item.id === id)) return fetchThenOpen(d, id)
  d.c.conversation.rememberPosition()
  state.workingDirectory = undefined
  if (state.tab !== "sessions") d.run.views.set(state.tab, { selected: state.selected, query: state.query })
  if (state.tab === "sessions" && state.selected && state.selected !== id) state.previousSession = state.selected
  state.searching = undefined
  d.ui.search.visible = false
  d.ui.search.value = ""
  state.query = inspect ? id : ""
  state.inspection = inspect ? id : ""
  state.inspected = session
  if (session && state.snapshot && !state.snapshot.sessions.some((item) => item.id === id))
    state.snapshot.sessions.push(session)
  state.tab = "sessions"
  state.selected = id
  state.detail = undefined
  ++state.detailVersion
  d.c.conversation.loadPosition()
  state.detailFocused = true
  state.navigating = false
  if (!d.c.conversation.hasLive(id) || inspect || state.tab !== "sessions") {
    d.ui.renderContent(inspect ? "Loading the attempted session…" : "Loading session…")
  }
  renderList(d)
  resize(d)
  if (!state.modal?.inline) void d.c.conversation.render()
  if (!inspect) return
  void d.refresh()
  d.say("Looking up the attempted session. n resumes draft; / changes search.")
  lookUpAttempted(d, id)
}

function fetchThenOpen(d: DashboardContext, id: string) {
  const { tab, selected } = d.state
  void d.connection.client.sessions
    .get({ sessionID: id })
    .then((fetched) => {
      // The user may have moved on while the fetch ran; opening now would yank the view back.
      if (d.state.closed || d.state.tab !== tab || d.state.selected !== selected) return
      openSession(d, id, false, fetched)
    })
    .catch((error: unknown) => {
      if (!d.state.closed) d.say(`Cannot open session ${id}: ${errorText(error)}`, true)
    })
}

function lookUpAttempted(d: DashboardContext, id: string) {
  const state = d.state
  void d.connection.client.sessions
    .get({ sessionID: id })
    .then((session) => {
      if (state.closed || state.tab !== "sessions" || state.inspection !== id || state.query !== id) return
      state.inspected = session
      if (state.snapshot && !state.snapshot.sessions.some((item) => item.id === id))
        state.snapshot.sessions.push(session)
      state.selected = id
      renderList(d)
      if (!state.modal?.inline) void d.c.conversation.render()
      if (!state.modal) d.say("Attempted session selected. n resumes draft; / changes search.")
    })
    .catch((error) => {
      if (state.closed || state.tab !== "sessions" || state.inspection !== id || state.query !== id) return
      d.say(`Cannot inspect this session: ${errorText(error)} Draft kept; n resumes.`, true)
      d.ui.renderContent(
        `Could not look up session ${id}.\n\n${errorText(error)}\n\nYour draft is kept. Press n to resume and inspect or retry.`,
      )
    })
}

/** Alt+Left / Alt+Right: the previous or next session in the snapshot, wrapping around. */
export function hop(d: DashboardContext, direction: number) {
  if (!d.c.dialogs.navigate()) return
  const sessions = d.state.snapshot?.sessions ?? []
  if (!sessions.length) return
  const index = sessions.findIndex((session) => session.id === d.state.selected)
  const next =
    index < 0 ? (direction > 0 ? 0 : sessions.length - 1) : (index + direction + sessions.length) % sessions.length
  openSession(d, sessions[next]!.id)
  // Hopping browses: the reply editor stays closed, so the next Alt+Left/Right hops again instead of moving a word.
  d.state.navigating = true
}

/** `/`: the session switcher on the Sessions tab, an inline sidebar search elsewhere. */
export function filter(d: DashboardContext) {
  if (!d.c.dialogs.navigate()) return
  if (d.state.tab === "sessions") return d.c.menus.switcher()
  d.state.searching = { query: d.state.query, selected: d.state.selected }
  d.state.sidebarHidden = false
  d.ui.search.value = d.state.query
  d.ui.search.visible = true
  resize(d)
  d.say("Type to search · ↑/↓ choose · Enter open · Esc cancel")
}

export function endSearch(d: DashboardContext, cancelled: boolean, keepDetail: boolean) {
  const state = d.state
  if (cancelled && state.searching) {
    state.query = state.searching.query
    state.selected = state.searching.selected
    renderList(d)
  }
  state.searching = undefined
  d.ui.search.visible = false
  state.detailFocused = keepDetail
  d.say(state.query ? `Search: ${label(state.query)} · / change or clear` : "")
  d.ui.focus()
  void d.c.conversation.render()
}
