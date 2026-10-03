import { color } from "../theme"
import { label } from "../state"
import { promptBoxText, statusline } from "../chrome"
import { contextUsage, meterText } from "../context-meter"
import { todoProgress } from "../session-actions"
import { waiting } from "../queue"
import { renderActivity } from "./status"
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
  ui.history.visible = state.tab === "sessions" && !!state.selected
  ui.harness.visible = ui.history.visible
  ui.changes.visible = ui.history.visible
  ui.files.visible = ui.history.visible
  ui.history.content = state.history ? "h Live" : "h History"
  const todos = todoProgress(pending?.todos ?? [])
  ui.tasks.visible = !!pending && (pending.tasks.data.length > 0 || pending.tasks.active.length > 0 || !!todos)
  ui.tasks.content = `t Tasks${todos ? ` · ${todos}` : ""}`
  const queued = waiting(pending?.pending).length
  ui.queued.visible = queued > 0
  ui.queued.content = `u ${queued} queued`
  const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
  const usage = pending && !state.history ? contextUsage(pending.messages) : undefined
  ui.meter.content = session && usage ? meterText(usage, d.c.limits(session.location.directory, usage.model)) : ""
  ui.meter.visible = !!ui.meter.content
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
