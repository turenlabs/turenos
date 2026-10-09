import { fg, t, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { color, layout } from "../theme"
import { canType, headerLeft, headerRight, sidebarTitle, statusline, welcomeBody } from "../chrome"
import { label, sessionTitle } from "../state"
import { activityFrame } from "../activity"
import { renderActionRow } from "./actions"
import type { DashboardContext } from "./context"
import { sidebarColumns } from "../layout/resize"

export function resize(d: DashboardContext) {
  d.run.shortcutsFor = shortcutsKey(d)
  d.ui.resize(quitArmed(d))
  // The editor's hint row fits the width, so a resize repaints it.
  if (d.state.modal?.composer) d.state.modal.refresh?.()
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
  // The pane's width once laid out, so a wide terminal keeps more of a retry's reason.
  const current = activityFrame(d.state, d.run.activityStep, d.state.reducedMotion, d.ui.activity.width || undefined)
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
  // The shortcuts are painted by the layout pass, so a change to what they depend on repaints through it.
  if (shortcutsKey(d) !== d.run.shortcutsFor) return resize(d)
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
 * Fits the top bar: the heading and the running state always stay. Buttons go first, lowest value
 * first (Servers, then Sessions), keeping host:port; then the address shortens to its port before the last
 * button goes, and the port outlasts every button. An address whose port does not fit even alone is left
 * out rather than cut: the dot still says whether the server answers.
 */
function renderServer(d: DashboardContext) {
  const ui = d.ui
  const dot = fg(d.state.connected ? color.added : d.state.connectionError ? color.error : color.warning)
  // The server name is clickable and `s` works without the label, which would crowd out the address.
  const buttons = [ui.serversButton, ui.switchButton, ui.modelButton]
  ui.serversButton.visible = !!d.options.servers
  ui.switchButton.visible = true
  ui.modelButton.visible = true
  // Below the compact breakpoint the buttons go, with or without an address.
  if (d.renderer.width < layout.compactBreakpoint) for (const node of buttons) node.visible = false
  if (!d.options.server) {
    ui.server.content = ""
    return
  }
  const text = label(d.options.server, 120)
  const address = addressOf(text)
  const port = /:\d+$/.exec(address)?.[0]
  if (d.renderer.width < layout.compactBreakpoint) return renderCompactServer(d, dot, address, port)
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
    // The port is the last form of the address to go, so it may also take every button's place.
    ...(port ? [...sets, []].map((nodes) => ({ tier: port, nodes })) : []),
  ]
  const whole = attempts.find((attempt) => attempt.tier.length <= room - others(attempt.nodes))
  for (const node of shown) {
    // The chosen form dropped this button (the port alone drops them all); the heading and running state stay.
    if (!whole?.nodes.includes(node)) node.visible = false
  }
  ui.server.content = t`${dot(d.state.connected ? "●" : "○")} ${whole?.tier ?? ""}`
}

/**
 * Below the compact breakpoint the buttons go (their keys stay in help and the palette) and a local server
 * is named by its port alone, so the run state keeps the row: `● 4097 · idle`.
 */
function renderCompactServer(d: DashboardContext, dot: ReturnType<typeof fg>, address: string, port?: string) {
  const ui = d.ui
  const local = /^(?:127(?:\.\d+){3}|localhost|\[?::1\]?)(?::\d+)?$/i.test(address)
  const room = d.renderer.width - 4 - 2 - ui.heading.plainText.length - ui.running.plainText.length - 6
  const name = local && port ? port.slice(1) : [address, port?.slice(1)].find((tier) => tier && tier.length <= room)
  const mark = d.state.connected ? "●" : "○"
  ui.server.content = t`${dot(mark)} ${name ?? ""}${ui.running.visible && name ? " ·" : ""}`
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
  if (!quitArmed(d)) return ""
  return `${d.state.modal ? "Ctrl+C" : "q"} again quits${d.run.quitDiscards ? " and discards" : ""}`
}

function quitArmed(d: DashboardContext) {
  return Date.now() < d.run.quitArmedUntil
}

/** What the footer shortcuts depend on besides the layout: an armed quit, whether Enter can return to typing and, on a narrow row, the status text beside them. */
function shortcutsKey(d: DashboardContext) {
  const narrow = d.renderer.width < layout.narrowBreakpoint
  return `${quitArmed(d)}:${canType(d.state)}:${narrow ? statusline(d.state, d.state.snapshot, d.renderer.width).length : 0}`
}

export function renderTabs(d: DashboardContext) {
  const buttons = d.ui.tabButtons
  // Inside the sidebar's border and padding; the narrow drawer spans the screen.
  const room = (d.renderer.width < layout.narrowBreakpoint ? d.renderer.width : sidebarColumns(d.renderer.width)) - 4
  const open = buttons.findIndex((item) => item.tab === d.state.tab)
  // The most descriptive set that fits: full names, four-letter names, then only the open view named.
  const sets = [
    buttons.map((item) => item.name),
    buttons.map((item) => item.short),
    buttons.map((item, index) => (index === open ? item.short : `${index + 1}`)),
  ]
  const labels = sets.find((set) => set.reduce((total, text) => total + text.length + 2, 0) <= room) ?? sets[2]!
  for (const [index, { tab, button }] of buttons.entries()) {
    // Brackets mark the open view, so `>` stays the list's selection marker.
    button.content = d.state.tab === tab ? `[${labels[index]}]` : ` ${labels[index]} `
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
