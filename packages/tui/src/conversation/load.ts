import { display } from "../messages"
import { stamp } from "../menus/stamp"
import { errorText } from "../server"
import { scheduleText, welcomeBody } from "../chrome"
import { label, type DashboardState } from "../state"
import { color } from "../theme"
import type { Conversation } from "./context"
import { drawLive } from "./live-cache"
import { currentView } from "./position"
import { loadSession } from "./session-load"
import { showRoom } from "../team"

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
      c.error = `Details unavailable: ${errorText(cause)}`
      // What was already read stays on screen (the status line says the data is saved); only a view with
      // nothing to show carries the error in its own pane.
      if (!keepTranscript(c)) {
        state.detail = undefined
        ui.renderContent(`${c.error}\n\nPress r to retry.`)
      }
      hooks.say(c.error, true)
      hooks.actions()
    })
}

/** Repaints the transcript the reader had, when there is one for the selected session. */
function keepTranscript(c: Conversation) {
  const { state } = c
  if (state.tab !== "sessions" || !state.selected) return false
  if (state.history) return state.detail?.sessionID === state.selected
  if (!c.live.has(state.selected)) return false
  drawLive(c)
  return true
}

async function load(c: Conversation, version: number) {
  const { state, ui } = c
  const id = state.selected
  const snapshot = state.snapshot
  if (!snapshot || state.closed) return
  ui.sessionTitle.fg = color.text
  if (state.tab === "team") return showRoom(c, id)
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
  ui.sessionTitle.content =
    state.tab === "sessions" ? "Welcome to TurenOS" : state.tab === "terminals" ? "Terminals" : "Automations"
}

function showTerminal(c: Conversation, snapshot: Snapshot, id: string) {
  const { state, ui } = c
  state.detail = undefined
  const item = snapshot.terminals.find((item) => item.id === id)
  if (!item) return
  ui.context.content = `${label(item.status)} · ${label(item.cwd, 250)}`
  // A server-named terminal is already called "Terminal …"; the heading does not say it twice.
  ui.sessionTitle.content = item.title ? label(item.title, 150) : "Terminal"
  ui.renderContent(
    // The title, status and folder are already in the heading and context line above.
    display(
      `$ ${[item.command, ...item.args].join(" ")}\n\nPID ${item.pid}${item.exitCode !== undefined ? `  ·  exit ${item.exitCode}` : ""}\n\n${item.status === "running" ? "Enter attaches (Ctrl+] detaches)\n" : ""}a add terminal · R rename · d close\n\nTerminal ID: ${item.id}${folderNote(snapshot)}`,
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
    `${triggerDetails}\nNext run: ${typeof item.nextRunAt === "number" ? stamp(item.nextRunAt) : "unscheduled"}\n\n${item.prompt}\n\nEnter manage (run now, pause, edit, runs)\na add · E edit · d delete\n\nAutomation ID: ${item.id}`,
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
