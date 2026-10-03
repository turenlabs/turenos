import { label } from "./state"
import type { DashboardState } from "./state"
import type { Detail, Snapshot } from "./server"

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
  return `Every ${schedule.seconds}s`
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

export function statusline(state: DashboardState, snapshot: Snapshot | undefined, _width: number) {
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
  const live =
    state.tab === "sessions" && !state.history && state.connected
      ? ` · ${state.streamStatus === "live" ? "Live" : "Polling"}`
      : ""
  return `${mode}${needsInput || working}${live}`
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
