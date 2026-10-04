import { fg, t, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { color, layout } from "../theme"
import { headerLeft, headerRight, sidebarTitle, statusline, welcomeBody } from "../chrome"
import { label } from "../state"
import { activityFrame } from "../activity"
import { renderActionRow } from "./actions"
import type { DashboardContext } from "./context"

export function resize(d: DashboardContext) {
  d.ui.resize()
  renderTabs(d)
  renderSidebarTitle(d)
  renderStatus(d)
  // The server picker owns focus while it is open; taking it back would send its input here.
  if (!d.options.blocked?.()) d.ui.focus()
  renderActionRow(d, d.state.detail?.sessionID === d.state.selected ? d.state.detail : undefined)
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
  d.ui.running.content = headerRight(d.state, d.state.snapshot)
  d.ui.running.visible = d.ui.running.plainText.length > 0
  renderServer(d)
  d.ui.footer.content = statusline(d.state, d.state.snapshot, d.renderer.width)
  d.ui.status.visible = !d.state.connected
  if (d.state.connected) return
  if (d.state.snapshot && d.state.tab === "sessions" && !d.state.selected && !d.state.query && !d.state.modal?.inline)
    d.ui.renderContent(welcomeBody("sessions", d.state))
  d.ui.status.content = d.state.connectionError
    ? `Disconnected${d.state.snapshot ? " · showing saved data" : ""} · retrying · i Details`
    : "Connecting…"
}

/**
 * Fits the top bar: the heading and the running state always stay. The address shortens first
 * (host:port, then the port); only then do buttons go, lowest value first, and the address does not
 * grow back, so a narrower terminal never shows more than a wider one.
 */
function renderServer(d: DashboardContext) {
  const ui = d.ui
  const dot = fg(d.state.connected ? color.added : d.state.connectionError ? color.error : color.warning)
  // The server name is clickable and `s` works without the label, which would crowd out the address.
  const buttons = [ui.serversButton, ui.switchButton, ui.modelButton]
  ui.serversButton.visible = !!d.options.servers
  ui.switchButton.visible = true
  ui.modelButton.visible = true
  if (!d.options.server) {
    ui.server.content = ""
    return
  }
  const text = label(d.options.server, 120)
  const address = addressOf(text)
  const tiers = [...new Set([text, address, /:\d+$/.exec(address)?.[0] ?? address])]
  const others = (nodes: typeof buttons) =>
    [ui.heading, ui.running, ...nodes]
      .filter((node) => node.visible)
      .reduce((sum, node) => sum + node.plainText.length + 3, 0)
  const room = d.renderer.width - 4 - 2
  const shown = buttons.filter((node) => node.visible)
  const whole = tiers.findIndex((tier) => tier.length <= room - others(shown))
  const tier = whole >= 0 ? tiers[whole]! : tiers.at(-1)!
  // Out of room even for the port: drop buttons, never the heading or the running state.
  for (const node of shown) {
    if (whole >= 0 || tier.length <= room - others(buttons)) break
    node.visible = false
  }
  ui.server.content = t`${dot(d.state.connected ? "●" : "○")} ${tier}`
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
  // The full names need a 46-column sidebar: the narrow drawer spans the screen, the side-by-side
  // sidebar is 30% of it from 154 columns. Everywhere else the short set is used for all three.
  const full = d.renderer.width < layout.narrowBreakpoint || d.renderer.width >= 154
  for (const [index, { tab, button, name }] of d.ui.tabButtons.entries()) {
    const text = full ? name : ["1 Chat", "2 Term", "3 Auto"][index]
    // Brackets mark the open view, so `>` stays the list's selection marker.
    button.content = d.state.tab === tab ? `[${text}]` : ` ${text} `
    button.fg = d.state.tab === tab ? color.accent : color.muted
    button.attributes = d.state.tab === tab ? TextAttributes.BOLD : TextAttributes.NONE
  }
}

/** The sidebar heading, with the way to close it when it is the narrow drawer. */
export function renderSidebarTitle(d: DashboardContext) {
  const drawer = d.renderer.width < layout.narrowBreakpoint && d.ui.sidebar.visible && !d.state.modal?.sidebar
  d.ui.sidebarHeading.content = sidebarTitle(d.state, d.state.rows.length, drawer)
}

/** Keeps the end of a long address (host:port, then the port) instead of cutting its middle. */
export function identifying(text: string, width: number) {
  const address = addressOf(text)
  if (text.length <= width) return text
  if (address.length <= width) return address
  const port = /:\d+$/.exec(address)?.[0]
  return port && port.length <= width ? port : text
}

function addressOf(text: string) {
  return text.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")
}
