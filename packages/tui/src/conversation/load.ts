import { display } from "../messages"
import { stamp } from "../menus/stamp"
import { errorText } from "../server"
import { scheduleText, welcomeBody } from "../chrome"
import { label, type DashboardState } from "../state"
import { color } from "../theme"
import type { Conversation } from "./context"
import { currentView } from "./position"
import { loadSession } from "./session-load"

type Snapshot = NonNullable<DashboardState["snapshot"]>

/**
 * Loads the selected view. A request for the view already loading runs at most once more after
 * the current load, and the current load still paints. Only a different view discards a load.
 */
export function render(c: Conversation) {
  const { state } = c
  if (c.disposed) return
  const key = `${currentView(c)}:${c.pageRequest?.cursor ?? ""}:${state.historyCursor ?? ""}`
  if (key !== c.loadKey) {
    c.loadKey = key
    ++state.detailVersion
  }
  if (c.loading) {
    c.refreshPending = true
    return c.loading
  }
  c.loading = drain(c).finally(() => {
    c.loading = undefined
  })
  return c.loading
}

async function drain(c: Conversation) {
  do {
    c.refreshPending = false
    await once(c, c.state.detailVersion)
  } while (c.refreshPending && !c.disposed && !c.state.closed)
}

function once(c: Conversation, version: number) {
  const { state, ui, hooks } = c
  return load(c, version)
    .then(() => {
      if (c.disposed || version !== state.detailVersion || state.closed) return
      if (c.error) hooks.clearNotice(c.error)
      c.error = ""
      hooks.actions()
    })
    .catch((cause) => {
      if (c.disposed || version !== state.detailVersion || state.closed) return
      c.pageRequest = undefined
      state.detail = undefined
      ui.renderContent(`Details unavailable: ${errorText(cause)}\n\nPress r to retry.`)
      c.error = `Details unavailable: ${errorText(cause)}`
      hooks.say(c.error, true)
      hooks.actions()
    })
}

async function load(c: Conversation, version: number) {
  const { state, ui } = c
  const id = state.selected
  const snapshot = state.snapshot
  if (!snapshot || state.closed) return
  ui.sessionTitle.fg = color.text
  const inventoryError = state.tab === "sessions" ? "" : snapshot.inventoryErrors[state.tab]
  if (inventoryError) return showInventoryError(c, inventoryError)
  if (!id) return showWelcome(c, snapshot)
  if (state.tab === "terminals") return showTerminal(c, snapshot, id)
  if (state.tab === "automations") return showAutomation(c, snapshot, id, version)
  const session = snapshot.sessions.find((session) => session.id === id)
  if (!session) return
  return loadSession(c, snapshot, session, version)
}

function showInventoryError(c: Conversation, inventoryError: string) {
  const { state, ui } = c
  state.detail = undefined
  ui.context.visible = false
  ui.sessionTitle.content = state.tab === "terminals" ? "Terminal inventory unavailable" : "Automations unavailable"
  ui.renderContent(`${inventoryError}\n\nPress r to retry. Sessions remain available: press 1.`)
}

function showWelcome(c: Conversation, snapshot: Snapshot) {
  const { state, ui } = c
  ui.context.visible = false
  state.detail = undefined
  ui.renderContent(
    state.query
      ? state.tab === "sessions" && snapshot.more
        ? "No matching recent or active sessions.\nOlder sessions are not loaded.\nPress / to change the filter."
        : "No matching items. Press / to change the filter."
      : state.tab === "sessions"
        ? welcomeBody("sessions", state)
        : state.tab === "terminals" && !snapshot.terminalsAvailable
          ? "Global terminal inventory is unavailable on this server version.\n\nUpdate the server to inspect terminal processes.\nSessions and agent launch are available."
          : state.tab === "terminals"
            ? `No terminals yet. Press Enter or a to open one.${folderNote(snapshot)}`
            : "No automations yet. Press a to add one.",
  )
  ui.sessionTitle.content = "Welcome to TurenOS"
}

function showTerminal(c: Conversation, snapshot: Snapshot, id: string) {
  const { state, ui } = c
  state.detail = undefined
  const item = snapshot.terminals.find((item) => item.id === id)
  if (!item) return
  ui.context.content = `${label(item.status)} · ${label(item.cwd, 250)}`
  ui.sessionTitle.content = item.title ? `Terminal · ${label(item.title, 150)}` : "Terminal"
  ui.renderContent(
    // The title and folder are already in the heading and context line above.
    display(
      `PID ${item.pid}  ·  ${item.status}${item.exitCode !== undefined ? `  ·  exit ${item.exitCode}` : ""}\n\n$ ${[item.command, ...item.args].join(" ")}\n\nID ${item.id}\n\n${item.status === "running" ? "Enter attaches (Ctrl+] detaches)\n" : ""}a add terminal · R rename · d close${folderNote(snapshot)}`,
    ),
  )
}

/** Folders whose terminals could not be read while others answered, so a short list is not mistaken for a full one. */
function folderNote(snapshot: Snapshot) {
  return snapshot.terminalFolderErrors.length
    ? `\n\nTerminals unavailable in: ${snapshot.terminalFolderErrors.map((item) => `${item.directory} (${item.error})`).join(", ")}`
    : ""
}

async function showAutomation(c: Conversation, snapshot: Snapshot, id: string, version: number) {
  const { state, ui } = c
  state.detail = undefined
  const item = snapshot.loops.find((item) => item.id === id)
  if (!item) return
  ui.sessionTitle.content = label(item.name || "Automation", 150)
  ui.context.content = `${label(item.status)} · ${label(item.location.directory, 250)}`
  const triggerDetails = item.eventTrigger
    ? `Trigger: ${scheduleText(item.schedule, item.eventTrigger)}\nSchedule: ${scheduleText(item.schedule)}`
    : scheduleText(item.schedule)
  const overview = display(
    `${triggerDetails}\nNext run: ${typeof item.nextRunAt === "number" ? stamp(item.nextRunAt) : "unscheduled"}\n\n${item.prompt}\n\nID ${item.id}\n\nEnter manage (run now, pause, edit, runs)\na add · E edit · d delete`,
  )
  ui.renderContent(overview)
  const runs = await c.connection.runs(id).catch((error: unknown) => errorText(error))
  if (version !== state.detailVersion || state.closed) return
  ui.renderContent(
    `${overview}\n\nRECENT RUNS\n${
      typeof runs === "string"
        ? `Run history unavailable: ${runs}\nPress r to retry.`
        : runs
            .slice(0, 10)
            // A run without its creation time (a malformed item) shows its ID rather than failing the pane.
            .map(
              (run) =>
                `${label(run.status)} · ${typeof run.time?.created === "number" ? stamp(run.time.created) : label(run.id)}`,
            )
            .join("\n") || "No runs yet."
    }`,
  )
}
