import { label } from "./state"
import { layout } from "./theme"
import type { DashboardState } from "./state"
import type { Detail, Snapshot } from "./server"
import { turnFailure } from "./messages/failure"
import { modelText } from "./messages/header"
import { scheduleInput } from "./automations/schedule"
import type { Loop } from "./automations/types"
import { viewOf, visibleRooms } from "./team/types"

export function scheduleText(
  schedule: Snapshot["loops"][number]["schedule"],
  eventTrigger?: Snapshot["loops"][number]["eventTrigger"],
) {
  if (eventTrigger) {
    if (eventTrigger.type === "file-change") {
      const paths = eventTrigger.paths.map((path) => label(path, 100)).join(", ")
      return `File change (${paths || "any"})${typeof eventTrigger.debounceMs === "number" ? ` · debounce ${eventTrigger.debounceMs}ms` : ""}`
    }
    if (eventTrigger.type === "session-end") {
      const parts: string[] = []
      if (eventTrigger.agent) parts.push(`agent: ${label(eventTrigger.agent, 50)}`)
      if (eventTrigger.sessionID) parts.push(`session: ${label(eventTrigger.sessionID, 50)}`)
      if (eventTrigger.outcomes?.length) parts.push(`outcome: ${eventTrigger.outcomes.join("/")}`)
      return `Session end (${parts.length ? parts.join(", ") : "any"})`
    }
  }
  if (schedule.type === "cron") return `Cron ${label(schedule.expression, 512)} (${label(schedule.timezone, 512)})`
  // scheduleInput reads only the schedule; it returns "every 30m", "every 1d" or "every 90s".
  return `Every ${scheduleInput({ schedule } as Loop).slice("every ".length)}`
}

export function headerLeft(_snapshot: Snapshot | undefined) {
  return "TurenOS"
}

export function headerRight(state: DashboardState, snapshot: Snapshot | undefined) {
  if (!state.connected) return state.connectionError ? "! Disconnected" : "Connecting…"
  if (!snapshot) return ""
  const running = Object.keys(snapshot.active).length
  // The active map is cut at 128 entries; a plus sign beats a count that is too small.
  const shown = snapshot.activeOmitted ? `${running}+` : `${running}`
  if (state.tab === "sessions") {
    const waiting = snapshot.needsInput?.length
    // The transcript shows the error itself; the header keeps saying so after the view scrolls on.
    const failure =
      state.detail?.sessionID === state.selected && !Object.hasOwn(snapshot.active, state.selected)
        ? turnFailure(state.detail.messages)
        : undefined
    return [
      // The context line no longer repeats this, so a waiting request shows here whether or not a turn runs.
      [running ? `● ${shown} running` : waiting ? "" : "idle", waiting ? `? ${waiting} need input` : ""]
        .filter(Boolean)
        .join(" · "),
      ...(failure ? [`! last turn ${failure.state}`] : []),
    ].join(" · ")
  }
  if (state.tab === "terminals")
    return snapshot.terminalsAvailable ? count(state, snapshot.terminals.length, "terminal") : "! Terminals unavailable"
  if (state.tab === "team")
    return viewOf(state).error ? "! Team unavailable" : count(state, visibleRooms(viewOf(state)).length, "room")
  return snapshot.inventoryErrors.automations
    ? "! Automations unavailable"
    : count(state, snapshot.loops.length, "automation")
}

/** "1 terminal", "3 terminals", or "2 of 3 terminals" when one is selected, so a hidden sidebar still says there are more. */
export function count(state: DashboardState, total: number, noun: string) {
  const position = state.rows.findIndex((row) => row.id === state.selected) + 1
  if (total === 1 || !position) return `${total} ${noun}${total === 1 ? "" : "s"}`
  return `${position} of ${total} ${noun}s`
}

/** The sidebar heading; the narrow drawer adds how to close it. */
export function sidebarTitle(state: DashboardState, count: number, drawer = false) {
  const name = { sessions: "Sessions", terminals: "Terminals", automations: "Automations", team: "Team" }[state.tab]
  return `${name} · ${count}${state.query ? " found" : ""}${drawer ? " · b close" : ""}`
}

/**
 * The footer's left side. It never repeats the line above the transcript (view, Working, Needs input);
 * it names the stream, the pane that has the keys, and the agent and model.
 */
export function statusline(state: DashboardState, snapshot: Snapshot | undefined, width: number, _armed = "") {
  // `_armed` stays for the dashboard's call: an armed quit is said once, by the status line's notice, not here.
  const narrow = width < layout.narrowBreakpoint
  const hidden = state.sidebarHidden ?? narrow
  const names = { sessions: "Sessions", terminals: "Terminals", automations: "Automations", team: "Team" }
  // Narrow footers share their row with the shortcuts, so only the unusual stream state is spelled out.
  const live =
    state.tab === "sessions" && !state.history && state.connected && !(narrow && state.streamStatus === "live")
      ? state.streamStatus === "live"
        ? "Live"
        : "Polling"
      : ""
  const typing = !!state.modal?.composer
  const focus = typing
    ? "Typing"
    : hidden
      ? ""
      : `Focus: ${state.detailFocused ? (state.tab === "sessions" ? "transcript" : "detail") : "sidebar"}`
  if (narrow) {
    const view = `${["sessions", "terminals", "automations", "team"].indexOf(state.tab) + 1}/4`
    return [hidden ? `${view} ${names[state.tab]}` : view, typing ? focus : hidden ? live : focus].filter(Boolean).join(" · ")
  }
  const base = [state.tab === "sessions" ? "" : names[state.tab], live, focus].filter(Boolean).join(" · ")
  const extra = agentModel(state, snapshot)
  // The shortcuts keep their row; the agent and model go first when the two would not fit together.
  const room = width - 4 - footerShortcuts(width, !hidden, typing, 26, canType(state)).length - 2
  return extra && base.length + 3 + extra.length <= room ? [base, extra].filter(Boolean).join(" · ") : base
}

/** Whether Enter returns to typing: a session is in view, which the reply editor opens on. */
export function canType(state: DashboardState) {
  return state.tab === "sessions" && !!state.selected && !state.history
}

/** The agent a session ran: its own setting, else the latest reply's when that reply is loaded. */
export function sessionAgent(state: DashboardState, session: Snapshot["sessions"][number]) {
  const reply =
    state.detail?.sessionID === session.id ? state.detail.messages.findLast((m) => m.type === "assistant") : undefined
  return session.agent ?? reply?.agent
}

/** "build · sandbox/scripted": the selected session's agent and model, else the latest reply's, else the server default. */
function agentModel(state: DashboardState, snapshot: Snapshot | undefined) {
  if (state.tab !== "sessions" || !state.selected) return ""
  const session = snapshot?.sessions.find((item) => item.id === state.selected)
  if (!session) return ""
  const reply =
    state.detail?.sessionID === session.id ? state.detail.messages.findLast((m) => m.type === "assistant") : undefined
  const model =
    session.model ??
    (reply && (reply.model.providerID !== "unknown" || reply.model.id !== "unknown") ? reply.model : undefined)
  const agent = sessionAgent(state, session) ?? state.defaultAgent
  return `${label(agent ?? "server default", 40)} · ${model ? label(modelText(model), 80) : "server default"}`
}

/**
 * The footer's right side, whole entries only. Narrow widths share the row with the status text on the left, `left` columns
 * (about 26 at most); `? help` outlasts every entry but the two the narrow footer was built around.
 */
export function footerShortcuts(
  width: number,
  sidebarVisible: boolean,
  typing = false,
  left = 26,
  canType = false,
) {
  const sidebar = sidebarVisible ? "Tab pane" : "b sidebar"
  const quit = "q quit"
  // The editor row names Esc and the send key, so while typing the footer adds only the palette.
  const sets = typing
    ? [["Ctrl+P commands"], ["Ctrl+P"]]
    : canType
      ? [
          // Narrow footers keep to the next likely action; the palette and the rest are in help.
          ...(width < layout.narrowBreakpoint ? [] : [["Enter type", "Ctrl+P commands", "? help"]]),
          ["Enter type", "? help"],
          ["? help"],
        ]
      : [
          ["Ctrl+P commands", sidebar, "? help", quit],
          ["Ctrl+P commands", sidebar, "? help"],
          ["Ctrl+P commands", "? help", quit],
          ["Ctrl+P commands", sidebar],
          [sidebar, "? help", quit],
          ["Ctrl+P commands", "? help"],
          [sidebar, "? help"],
          ["? help"],
        ]
  const budget = width - 4 - (width < layout.narrowBreakpoint ? left + 2 : 0)
  return (sets.find((set) => set.join(" · ").length <= budget) ?? sets.at(-1)!).join(" · ")
}

export function promptBoxText(
  state: DashboardState,
  detail: Detail | undefined,
  opts: { hasDraft: boolean; agentModel?: string },
) {
  if (!state.connected) return "r Retry connection"
  if (state.tab === "team")
    return !state.selected
      ? "r Refresh"
      : state.team?.room?.archived
        ? "Archived · read-only · d Restore or delete"
        : "f Post"
  if (state.tab !== "sessions" || !state.selected) return "n New session · / Find · Ctrl+K Switch"
  if (detail?.permissions.length)
    return `p Review permission${detail.permissions.length > 1 ? ` (${detail.permissions.length})` : ""} · needs input`
  if (detail?.questions.length)
    return `o Answer question${detail.questions.length > 1 ? ` (${detail.questions.length})` : ""} · needs input`
  // The footer names the key that returns to typing, so this line only says what a click here does.
  return opts.hasDraft ? "Draft kept" : "Message…"
}

export function welcomeBody(
  tab: DashboardState["tab"],
  connection?: Pick<DashboardState, "connected" | "connectionError"> &
    Partial<Pick<DashboardState, "serverSwitching" | "sidebarHidden" | "columns">>,
) {
  if (tab === "team")
    return "No Team rooms found.\n\nPress 1 for sessions · 2 for terminals · 3 for automations · 4 for Team.\nctrl+p lists every command."
  if (tab !== "sessions")
    return `No ${tab} found.\n\n${tab === "terminals" ? "a opens a terminal on the server." : "a adds an automation."}\nPress 1 for sessions · 2 for terminals · 3 for automations · 4 for Team.\nctrl+p lists every command.`
  const status = connection
    ? connection.connected
      ? "Connected"
      : connection.connectionError
        ? "Disconnected"
        : "Connecting…"
    : ""
  return [
    "[ Turen ]",
    `${status ? `${status} · ` : ""}No session selected.`,
    "",
    "Press n or Enter to start a session.",
    "In a message: / commands · @ files · ! shell",
    "? help · Ctrl+P commands · m model · Ctrl+K sessions",
    ...((connection?.sidebarHidden ?? (connection?.columns ?? 0) < layout.narrowBreakpoint)
      ? ["b shows the session list"]
      : []),
    `, settings · I intel${connection?.serverSwitching ? " · s servers" : ""}`,
  ].join("\n")
}

/** Shortens a path to `width` columns by dropping leading folders (`…/shots/project`), never cutting inside a name. */
export function fitPath(path: string, width: number) {
  if (path.length <= width) return path
  const parts = path.split("/").filter(Boolean)
  const kept = parts.findIndex((_, index) => `…/${parts.slice(index).join("/")}`.length <= width)
  if (kept < 0) return `…${path.slice(path.length - Math.max(1, width - 1))}`
  return `…/${parts.slice(kept).join("/")}`
}
