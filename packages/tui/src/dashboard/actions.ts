import { color } from "../theme"
import { label } from "../state"
import { promptBoxText, statusline } from "../chrome"
import { contextUsage, meterText } from "../context-meter"
import { todoProgress } from "../session-actions"
import { waiting } from "../queue"
import { fitActionRow } from "../layout/fit"
import { renderActivity } from "./status"
import type { Detail } from "../server"
import type { DashboardContext } from "./context"

/** Repaints the sidebar actions, the composer line and the action row under the transcript. */
export function renderActions(d: DashboardContext) {
  const state = d.state
  const ui = d.ui
  renderActivity(d)
  ui.sidebarActions.content = ` + ${d.c.launch.hasDraft ? "Resume draft" : "New session"}    n\n / ${state.query && state.query !== state.inspection ? `Find: ${label(state.query, 18)}` : `Find ${state.tab === "sessions" ? "a session" : "items"}`}`
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
  ui.composer.content = `${primary}${staged ? " · commits undo" : ""} · Enter`
  ui.composer.fg =
    !state.connected || pending?.permissions.length || pending?.questions.length ? color.warning : color.text
  ui.composer.visible = !state.connected || (state.tab === "sessions" && !!state.selected)
  renderActionRow(d, pending)
  ui.historyActions.visible = state.tab === "sessions" && state.history && !!state.selected && !state.modal?.inline
  ui.older.fg = pending?.cursor.next ? color.accent : color.muted
  ui.newer.fg = pending?.cursor.previous ? color.accent : color.muted
  ui.historyCount.content = pending
    ? `${pending.messages.length} messages${pending.cursor.next ? "" : " · start"}`
    : "Loading…"
  ui.footer.content = statusline(state, state.snapshot, d.renderer.width)
  queueMicrotask(() => {
    if (!ui.sizeNotice.visible && !d.options.blocked?.()) d.c.requests.offerQuestion()
  })
}

/** Repaints the entries under the transcript, fitted whole to the width. Also runs on resize. */
export function renderActionRow(d: DashboardContext, pending?: Detail) {
  const state = d.state
  const ui = d.ui
  const live = state.tab === "sessions" && !!state.selected
  const running = live && !!state.snapshot && Object.hasOwn(state.snapshot.active, state.selected)
  const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
  const todos = todoProgress(pending?.todos ?? [])
  const hasTasks = !!pending && (pending.tasks.data.length > 0 || pending.tasks.active.length > 0 || !!todos)
  const queued = waiting(pending?.pending).length
  const usage = pending && !state.history ? contextUsage(pending.messages) : undefined
  const limit = session && usage ? d.c.limits(session.location.directory, usage.model) : undefined
  const meter = session && usage ? meterText(usage, limit) : ""
  const row = [
    { node: ui.stop, show: running, text: "x Stop", rank: 100 },
    { node: ui.history, show: live, text: state.history ? "h Live" : "h History", rank: 50 },
    { node: ui.information, show: true, text: "i Details", rank: 40 },
    { node: ui.changes, show: live, text: "d Changes", rank: 30 },
    { node: ui.files, show: live, text: "e Files", rank: 20 },
    { node: ui.tasks, show: hasTasks, text: `t Tasks${todos ? ` · ${todos}` : ""}`, short: "t Tasks", rank: 60 },
    { node: ui.queued, show: queued > 0, text: `u ${queued} queued`, short: `u ${queued}`, rank: 90 },
    { node: ui.harness, show: live, text: "H Harness", rank: 10 },
    { node: ui.meter, show: !!meter, text: meter, short: usage && meterText(usage, limit, true), rank: 80 },
  ]
  fitActionRow(row, actionWidth(d))
  ui.actions.visible = !state.modal && ui.composer.visible
}

/** Columns left for the action row: the screen minus the root padding, a beside-layout sidebar, and the row's own border and padding. */
function actionWidth(d: DashboardContext) {
  const sidebar = d.ui.sidebar.visible && typeof d.ui.sidebar.width === "number" ? d.ui.sidebar.width + 2 : 0
  return d.renderer.width - 4 - sidebar - 5
}

/** Enter in the detail pane, or a click on the composer: the action the current tab and selection call for. */
export function primaryAction(d: DashboardContext) {
  const state = d.state
  if (state.modal) return
  if (!state.connected || d.c.conversation.error) return void d.refresh()
  if (state.tab === "terminals") return state.selected ? d.c.terminals.open() : d.c.terminals.create()
  if (state.tab === "automations") return state.selected ? d.c.automations.manage() : d.c.automations.create()
  if (state.tab !== "sessions" || !state.selected) return d.c.launch.open()
  const pending = state.detail?.sessionID === state.selected ? state.detail : undefined
  if (pending?.permissions.length) return d.c.requests.permission()
  if (pending?.questions.length) return d.c.requests.question()
  d.c.requests.followup()
}
