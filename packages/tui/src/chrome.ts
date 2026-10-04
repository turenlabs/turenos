import { label } from "./state"
import { layout } from "./theme"
import type { DashboardState } from "./state"
import type { Detail, Snapshot } from "./server"
import { scheduleInput } from "./automations/schedule"
import type { Loop } from "./automations/types"

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
  if (!state.connected) return state.connectionError ? "Disconnected" : "Connecting…"
  if (!snapshot) return ""
  const running = Object.keys(snapshot.active).length
  if (state.tab === "sessions") return running ? `● ${running} running` : "idle"
  if (state.tab === "terminals")
    return snapshot.terminalsAvailable ? `${snapshot.terminals.length} terminals` : "Terminals unavailable"
  return snapshot.inventoryErrors.automations ? "Automations unavailable" : `${snapshot.loops.length} automations`
}

export function sidebarTitle(state: DashboardState, count: number) {
  const name = state.tab === "sessions" ? "Sessions" : state.tab === "terminals" ? "Terminals" : "Automations"
  if (state.query) return `${name} · ${count} found`
  return `${name} · ${count}`
}

export function statusline(state: DashboardState, snapshot: Snapshot | undefined, width: number) {
  const mode =
    state.tab === "sessions"
      ? state.history
        ? "History"
        : "Transcript"
      : state.tab === "terminals"
        ? "Terminals"
        : "Automations"
  const working = state.detail && snapshot && Object.hasOwn(snapshot.active, state.detail.sessionID) ? " · Working" : ""
  const needsInput = state.detail?.permissions.length || state.detail?.questions.length ? " · Needs input" : ""
  const narrow = width < layout.narrowBreakpoint
  // Narrow footers share their row with the shortcuts, so only the unusual stream state is spelled out.
  const live =
    state.tab === "sessions" && !state.history && state.connected && !(narrow && state.streamStatus === "live")
      ? ` · ${state.streamStatus === "live" ? "Live" : "Polling"}`
      : ""
  const tab = narrow ? `${["sessions", "terminals", "automations"].indexOf(state.tab) + 1}/3 ` : ""
  const focus = `Focus: ${state.detailFocused ? "transcript" : state.tab}`
  const hidden = state.sidebarHidden ?? narrow
  if (narrow) return hidden ? `${tab}${mode}${needsInput || working}${live}` : `${tab}${focus}${needsInput || working}`
  const base = `${tab}${mode}${needsInput || working}${live}${hidden ? "" : ` · ${focus}`}`
  const extra = agentModel(state, snapshot)
  // The shortcuts keep their row; the agent and model go first when the two would not fit together.
  const room = width - 4 - footerShortcuts(width, !hidden).length - 2
  return extra && base.length + 3 + extra.length <= room ? `${base} · ${extra}` : base
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
  const agent = session.agent ?? reply?.agent
  return `${label(agent ?? "server default", 40)} · ${model ? label(`${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`, 80) : "server default"}`
}

/** The footer's right side. Narrow widths budget for a status text of about 26 columns on the left. */
export function footerShortcuts(width: number, sidebarVisible: boolean) {
  const sidebar = sidebarVisible ? "Tab pane" : "b sidebar"
  const sets = [
    ["Ctrl+P commands", sidebar, "? help", "q quit"],
    ["Ctrl+P", sidebar, "? help", "q quit"],
    [sidebar, "? help", "q quit"],
    [sidebar, "q quit"],
  ]
  const budget = width - 4 - (width < layout.narrowBreakpoint ? 28 : 0)
  return (sets.find((set) => set.join(" · ").length <= budget) ?? sets[3]!).join(" · ")
}

export function promptBoxText(
  state: DashboardState,
  detail: Detail | undefined,
  opts: { hasDraft: boolean; agentModel?: string },
) {
  if (!state.connected) return "r Retry connection"
  if (state.tab !== "sessions" || !state.selected) return "n New session · / Find · Ctrl+K Switch"
  if (detail?.permissions.length)
    return `p Review permission${detail.permissions.length > 1 ? ` (${detail.permissions.length})` : ""} · needs input`
  if (detail?.questions.length)
    return `o Answer question${detail.questions.length > 1 ? ` (${detail.questions.length})` : ""} · needs input`
  return `f ${opts.hasDraft ? "Resume reply" : "Reply"} · / Commands`
}

export function welcomeBody(
  tab: DashboardState["tab"],
  connection?: Pick<DashboardState, "connected" | "connectionError"> & { serverSwitching?: boolean },
) {
  if (tab !== "sessions")
    return `No ${tab} found.\n\n${tab === "terminals" ? "a opens a terminal on the server." : "a adds an automation."}\nPress 1 for sessions · 2 for terminals · 3 for automations.\nctrl+p lists every command.`
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
    "n New session",
    "Ctrl+K Session picker",
    ...(connection?.serverSwitching ? ["s Switch server"] : []),
    ", Settings · I Intel",
    "? Help",
  ].join("\n")
}
