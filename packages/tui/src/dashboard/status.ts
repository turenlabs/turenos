import { fg, t, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { color, layout } from "../theme"
import { headerLeft, headerRight, sidebarTitle, statusline, welcomeBody } from "../chrome"
import { label, sessionTitle } from "../state"
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
  renderAttention(d)
  dropStaleNotice(d)
  d.ui.footer.content = statusline(d.state, d.state.snapshot, d.renderer.width, quitPrompt(d))
  d.ui.status.visible = !d.state.connected
  if (d.state.connected) return
  if (d.state.snapshot && d.state.tab === "sessions" && !d.state.selected && !d.state.query && !d.state.modal?.inline)
    d.ui.renderContent(welcomeBody("sessions", d.state))
  d.ui.status.content = d.state.connectionError
    ? `Disconnected${d.state.snapshot ? " · showing saved data" : ""} · retrying · i Details`
    : "Connecting…"
}

function writeTerminal(d: DashboardContext, text: string) {
  const terminal = d.options.terminal ?? (process.stdout.isTTY ? process.stdout : undefined)
  terminal?.write(text)
}

function ring(d: DashboardContext) {
  if (d.state.attention) writeTerminal(d, "\x07")
}

/** A request needs the user: bell, and the title says so. */
export function attend(d: DashboardContext) {
  ring(d)
  renderAttention(d)
}

/**
 * Keeps the terminal title in step with the selected session (`TurenOS · needs input · title`) and
 * rings once when its running turn ends. OpenTUI resets the title itself on suspend and exit.
 */
export function renderAttention(d: DashboardContext) {
  const state = d.state
  const snapshot = state.snapshot
  if (!state.connected || !snapshot) return writeTitle(d, "TurenOS · disconnected")
  const active = Object.keys(snapshot.active)
  const session = state.tab === "sessions" ? snapshot.sessions.find((item) => item.id === state.selected) : undefined
  const running = session ? active.includes(session.id) : active.length > 0
  const waiting = session
    ? snapshot.needsInput?.includes(session.id) ||
      (state.detail?.sessionID === session.id && !!(state.detail.permissions.length || state.detail.questions.length))
    : !!snapshot.needsInput
  const ended = !!state.workingSession && state.workingSession === session?.id && !running
  state.workingSession = session && running ? session.id : ""
  if (ended) ring(d)
  const name = session ? ` · ${sessionTitle(session.title || session.id, 60)}` : ""
  writeTitle(d, `TurenOS · ${waiting ? "needs input" : running ? "working" : "idle"}${name}`)
}

function writeTitle(d: DashboardContext, title: string) {
  if (!d.state.attention || d.state.closed || d.state.terminalTitle === title) return
  d.state.terminalTitle = title
  writeTerminal(d, `\x1b]2;${title}\x07`)
}

/** Clears the title this dashboard wrote, so it does not outlive the dashboard or the setting. */
export function clearTitle(d: DashboardContext) {
  if (!d.state.terminalTitle) return
  d.state.terminalTitle = ""
  writeTerminal(d, "\x1b]2;\x07")
}

/**
 * Fits the top bar: the heading and the running state always stay. The address shortens first
 * (host:port, then the port); only then do buttons go, lowest value first, and the address does not
 * grow back, so a narrower terminal never shows more than a wider one. An address that fits in no form
 * is left out rather than cut: the dot still says whether the server answers.
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
  const port = /:\d+$/.exec(address)?.[0]
  const others = (nodes: typeof buttons) =>
    [ui.heading, ui.running, ...nodes]
      .filter((node) => node.visible)
      .reduce((sum, node) => sum + node.plainText.length + 3, 0)
  // Two columns are the dot and its space.
  const room = d.renderer.width - 4 - 2 - 2
  const shown = buttons.filter((node) => node.visible)
  // The Servers button goes before the host does, the Sessions button next, and the host before the port.
  const sets = [
    shown,
    shown.filter((node) => node !== ui.serversButton),
    shown.filter((node) => node === ui.modelButton),
  ]
  const attempts = [
    ...sets.flatMap((nodes) => [...new Set([text, address])].map((tier) => ({ tier, nodes }))),
    ...(port && port !== address ? sets.map((nodes) => ({ tier: port, nodes })) : []),
  ]
  const whole = attempts.find((attempt) => attempt.tier.length <= room - others(attempt.nodes))
  for (const node of shown) {
    // Out of room even for the port: drop every button, never the heading or the running state.
    if (!whole?.nodes.includes(node)) node.visible = false
  }
  ui.server.content = t`${dot(d.state.connected ? "●" : "○")} ${whole?.tier ?? ""}`
}

export function say(d: DashboardContext, message: string, error = false) {
  if (d.state.closed) return
  d.run.noticeScope = message && !error ? { selected: d.state.selected, running: selectedRunning(d) } : undefined
  d.ui.notice.content = `${message && error ? "! " : ""}${display(message, 1000)}`
  d.run.noticeMessage = message
  d.ui.notice.visible = !!message
  d.ui.notice.fg = error ? color.error : color.muted
  if (d.run.noticeTimer) clearTimeout(d.run.noticeTimer)
  if (message && !error)
    d.run.noticeTimer = setTimeout(() => {
      d.run.noticeMessage = ""
      d.run.noticeScope = undefined
      d.ui.notice.visible = false
    }, 5000)
}

function selectedRunning(d: DashboardContext) {
  return !!d.state.selected && Object.hasOwn(d.state.snapshot?.active ?? {}, d.state.selected)
}

/** The next key ends a plain message: it was news about the moment before it (a draft discarded, a prompt to press Esc again). */
export function dropNotice(d: DashboardContext) {
  if (d.run.noticeScope) say(d, "")
}

/** A message said while a turn ran, or about another selection, no longer describes what is on screen. */
function dropStaleNotice(d: DashboardContext) {
  const scope = d.run.noticeScope
  // An armed quit's message ("Session interrupted. Ctrl+C again quits.") is about the turn that just ended.
  if (Date.now() < d.run.quitArmedUntil) return
  if (scope && (scope.selected !== d.state.selected || (scope.running && !selectedRunning(d)))) say(d, "")
}

/** What the next quit key does while a quit is armed, so the footer says it as well as the status line. */
export function quitPrompt(d: DashboardContext) {
  if (!(Date.now() < d.run.quitArmedUntil)) return ""
  return `${d.state.modal ? "Ctrl+C" : "q"} again quits${d.run.quitDiscards ? " and discards" : ""}`
}

export function renderTabs(d: DashboardContext) {
  // The full names need a 46-column sidebar: the narrow drawer spans the screen, the side-by-side
  // sidebar is 30% of it from 154 columns. Everywhere else each name is cut to its first four letters.
  const full = d.renderer.width < layout.narrowBreakpoint || d.renderer.width >= 154
  for (const [index, { tab, button, name }] of d.ui.tabButtons.entries()) {
    const text = full ? name : ["1 Sess", "2 Term", "3 Auto"][index]
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
