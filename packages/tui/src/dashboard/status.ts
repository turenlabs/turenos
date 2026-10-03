import { fg, t, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { color } from "../theme"
import { headerLeft, headerRight, statusline, welcomeBody } from "../chrome"
import { label } from "../state"
import { activityFrame } from "../activity"
import type { DashboardContext } from "./context"

export function resize(d: DashboardContext) {
  d.ui.resize()
  renderTabs(d)
  renderStatus(d)
  // The server picker owns focus while it is open; taking it back would send its input here.
  if (!d.options.blocked?.()) d.ui.focus()
  renderActivity(d)
}

export function renderActivity(d: DashboardContext) {
  if (d.state.closed) return
  const current = activityFrame(d.state, d.run.activityStep, d.state.reducedMotion)
  d.ui.activity.visible = !!current && !d.state.modal?.inline && !d.ui.sizeNotice.visible
  d.ui.activity.content = current?.content ?? ""
  d.ui.activity.fg = color[current?.tone ?? "muted"]
  if (current?.animate && d.ui.activity.visible && !d.run.activityTimer)
    d.run.activityTimer = setInterval(() => {
      d.run.activityStep++
      renderActivity(d)
    }, 100)
  if ((!current?.animate || !d.ui.activity.visible) && d.run.activityTimer) {
    clearInterval(d.run.activityTimer)
    d.run.activityTimer = undefined
  }
}

export function renderStatus(d: DashboardContext) {
  d.ui.heading.content = d.renderer.width < 90 ? "TurenOS" : headerLeft(d.state.snapshot)
  const dot = fg(d.state.connected ? color.added : d.state.connectionError ? color.error : color.warning)
  d.ui.server.content = d.options.server ? t`${dot(d.state.connected ? "●" : "○")} ${label(d.options.server, 120)}` : ""
  d.ui.running.content = headerRight(d.state, d.state.snapshot)
  d.ui.footer.content = statusline(d.state, d.state.snapshot, d.renderer.width)
  d.ui.status.visible = !d.state.connected
  if (d.state.connected) return
  if (d.state.snapshot && d.state.tab === "sessions" && !d.state.selected && !d.state.query && !d.state.modal?.inline)
    d.ui.renderContent(welcomeBody("sessions", d.state))
  d.ui.status.content = d.state.connectionError
    ? `Disconnected${d.state.snapshot ? " · showing saved data" : ""} · retrying · i Details`
    : "Connecting…"
}

export function say(d: DashboardContext, message: string, error = false) {
  if (d.state.closed) return
  d.ui.notice.content = `${message && error ? "! " : ""}${display(message, 1000)}`
  d.run.noticeMessage = message
  d.ui.notice.visible = !!message
  d.ui.notice.fg = error ? color.error : color.muted
  if (d.run.noticeTimer) clearTimeout(d.run.noticeTimer)
  if (message && !error)
    d.run.noticeTimer = setTimeout(() => {
      d.run.noticeMessage = ""
      d.ui.notice.visible = false
    }, 5000)
}

export function renderTabs(d: DashboardContext) {
  for (const [index, { tab, button, name }] of d.ui.tabButtons.entries()) {
    button.content = `${d.state.tab === tab ? "> " : ""}${d.renderer.width >= 90 ? ["1 Chat", "2 Term", "3 Auto"][index] : name}  `
    button.fg = d.state.tab === tab ? color.accent : color.muted
    button.attributes = d.state.tab === tab ? TextAttributes.BOLD : TextAttributes.NONE
  }
}
