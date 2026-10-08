import { color, layout } from "../theme"
import { label } from "../state"
import { promptBoxText, statusline } from "../chrome"
import { contextUsage, meterText } from "../context-meter"
import { todoProgress } from "../session-actions"
import { waiting } from "../queue"
import { fitActionRow } from "../layout/fit"
import { quitPrompt, renderActivity, resize } from "./status"
import type { Detail } from "../server"
import type { DashboardContext } from "./context"

/** Repaints the sidebar actions, the composer line and the action row under the transcript. */
export function renderActions(d: DashboardContext) {
  const state = d.state
  const ui = d.ui
  renderActivity(d)
  ui.sidebarActions.content = sidebarActions(d)
  const pending = state.detail?.sessionID === state.selected ? state.detail : undefined
  const reply = promptBoxText(state, pending, {
    hasDraft: d.c.requests.hasDraft(state.selected),
  })
  const primary =
    d.c.conversation.error && state.connected
      ? "r Retry details"
      : d.c.requests.replyBlocked(state.selected) && !pending?.permissions.length && !pending?.questions.length
        ? "f Owning session (read-only)"
        : reply
  const staged = state.snapshot?.sessions.find((session) => session.id === state.selected)?.revert
  ui.composer.content = `${primary}${staged ? " · commits undo" : ""}`
  ui.composer.fg =
    !state.connected || pending?.permissions.length || pending?.questions.length ? color.warning : color.text
  // While typing, the reply editor stands in for this prompt line.
  ui.composer.visible =
    !state.modal?.composer &&
    (!state.connected || ((state.tab === "sessions" || state.tab === "team") && !!state.selected))
  renderActionRow(d, pending)
  ui.historyActions.visible = state.tab === "sessions" && state.history && !!state.selected && !state.modal?.inline
  ui.older.fg = pending?.cursor.next ? color.accent : color.muted
  ui.newer.fg = pending?.cursor.previous ? color.accent : color.muted
  ui.historyCount.content = pending
    ? `${pending.messages.length} messages${pending.cursor.next ? "" : " · start"}`
    : "Loading…"
  ui.footer.content = statusline(state, state.snapshot, d.renderer.width, quitPrompt(d))
  queueMicrotask(() => {
    if (ui.sizeNotice.visible || d.options.blocked?.()) return
    const before = state.modal
    d.c.requests.offerInput()
    // Opening a dialog here changes the rows below the transcript (the reply editor hides the prompt line).
    if (state.modal === before) return
    renderActions(d)
    resize(d)
  })
}

/** The two sidebar entries; the first is what `n` (sessions) or `a` (terminals, automations) does. */
function sidebarActions(d: DashboardContext) {
  const state = d.state
  const noun = { sessions: "a session", terminals: "a terminal", automations: "an automation", team: "a room" }[
    state.tab
  ]
  const add =
    state.tab === "sessions"
      ? `${d.c.launch.hasDraft ? "Resume draft" : "New session"}    n`
      : state.tab === "team"
        ? "New room    a"
        : `New ${state.tab === "terminals" ? "terminal" : "automation"}    a`
  return ` + ${add}\n / ${state.query && state.query !== state.inspection ? `Find: ${label(state.query, 18)}` : `Find ${noun}`}`
}

/** Repaints the entries under the transcript, fitted whole to the width. Also runs on resize. */
export function renderActionRow(d: DashboardContext, pending?: Detail) {
  const state = d.state
  const ui = d.ui
  const live = state.tab === "sessions" && !!state.selected
  const room = state.tab === "team" && !!state.selected
  const running = live && !!state.snapshot && Object.hasOwn(state.snapshot.active, state.selected)
  const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
  const todos = todoProgress(pending?.todos ?? [])
  const hasTasks = !!pending && (pending.tasks.data.length > 0 || pending.tasks.active.length > 0 || !!todos)
  const queued = waiting(pending?.pending).length
  const usage = pending && !state.history ? contextUsage(pending.messages) : undefined
  const limit = session && usage ? d.c.limits(session.location.directory, usage.model) : undefined
  const meter = session && usage ? meterText(usage, limit) : ""
  // While typing, letters go into the reply, so the row keeps only its status, without the keys.
  const typing = !!state.modal?.composer
  const key = (letter: string) => (typing ? "" : `${letter} `)
  const row = [
    { node: ui.stop, show: running && !typing, text: "x Stop", rank: 100 },
    {
      node: ui.history,
      show: (live || room) && !typing,
      text: room ? "A Archived" : state.history ? "h Live" : "h History",
      rank: 50,
    },
    { node: ui.information, show: !typing, text: "i Details", rank: 40 },
    { node: ui.changes, show: (live || room) && !typing, text: room ? "M Members" : "d Changes", rank: 30 },
    {
      node: ui.files,
      show: (live || (room && !!state.team?.hasMore)) && !typing,
      text: room ? "[ Older" : "e Files",
      rank: 20,
    },
    {
      node: ui.tasks,
      show: hasTasks || room,
      text: `${key("t")}Tasks${todos ? ` · ${todos}` : ""}`,
      short: `${key("t")}Tasks`,
      rank: 60,
    },
    { node: ui.queued, show: queued > 0, text: `${key("u")}${queued} queued`, short: `${key("u")}${queued}`, rank: 90 },
    { node: ui.harness, show: (live || room) && !typing, text: room ? "F Factory" : "H Harness", rank: 10 },
    { node: ui.meter, show: !!meter, text: meter, short: usage && meterText(usage, limit, true), rank: 80 },
  ]
  const width = actionWidth(d)
  fitActionRow(row, width)
  // A row that left entries out says so: the … stands for the rest, which are in Ctrl+P.
  if (row.some((entry) => entry.show && !entry.node.visible)) {
    fitActionRow(row, width - 2)
    // The … follows the last action, not the context meter, which would read as cut.
    const last = row.findLast((entry) => entry.node.visible && entry.node !== ui.meter)
    if (last) last.node.content = `${last.node.plainText} …`
  }
  ui.actions.visible = typing || (!state.modal && ui.composer.visible)
  ui.actions.height = typing ? 1 : 2
  ui.actions.marginTop = typing ? 0 : 1
}

/** Columns left for the action row: the screen minus the root padding, a beside-layout sidebar (the narrow drawer sits under the transcript), and the row's own border and padding. */
function actionWidth(d: DashboardContext) {
  const beside = d.renderer.width >= layout.narrowBreakpoint
  const sidebar = beside && d.ui.sidebar.visible && typeof d.ui.sidebar.width === "number" ? d.ui.sidebar.width + 2 : 0
  return d.renderer.width - 4 - sidebar - 5
}

/** Enter in the detail pane, or a click on the composer: the action the current tab and selection call for. */
export function primaryAction(d: DashboardContext) {
  const state = d.state
  if (state.modal) return
  if (!state.connected || d.c.conversation.error) return void d.refresh()
  if (state.tab === "terminals") return state.selected ? d.c.terminals.open() : d.c.terminals.create()
  if (state.tab === "automations") return state.selected ? d.c.automations.manage() : d.c.automations.create()
  if (state.tab === "team") return d.c.team.post()
  if (state.tab !== "sessions" || !state.selected) return d.c.launch.open()
  // Enter goes back to typing: once a request it opens is answered, the reply editor returns.
  state.navigating = false
  const pending = state.detail?.sessionID === state.selected ? state.detail : undefined
  if (pending?.permissions.length) return d.c.requests.permission()
  if (pending?.questions.length) return d.c.requests.question()
  d.c.requests.followup()
}
