import { label } from "../state"
import type { DashboardState } from "../state"
import { headerLeft, headerRight, scheduleText } from "../chrome"
import { sessionRows, type SidebarRow } from "../session-list"
import { folderContains } from "../working-folders"
import { renderActions } from "./actions"
import { renderSidebarTitle, renderTabs } from "./status"
import type { DashboardContext } from "./context"

type Snapshot = NonNullable<DashboardState["snapshot"]>

/** Rebuilds the sidebar list for the current tab, search and selection. */
export function renderList(d: DashboardContext) {
  renderTabs(d)
  const snapshot = d.state.snapshot
  if (!snapshot) return
  const filtered = matching(d.state, listRows(d.state, snapshot))
  d.state.rows = filtered
  const index = d.state.rows.findIndex((row) => row.id === (d.state.selected || defaultSelection(d, snapshot)))
  const selected = d.state.rows[Math.max(0, index)]?.id ?? ""
  if (d.state.selected !== selected) {
    d.c.conversation.rememberPosition()
    d.state.selected = selected
    if (d.state.tab === "sessions") d.c.conversation.loadPosition()
  }
  d.run.renderingList = true
  d.ui.list.options = filtered
  if (d.state.rows.length) d.ui.list.setSelectedIndex(Math.max(0, index), false)
  d.run.renderingList = false
  renderSidebar(d, snapshot)
  renderActions(d)
}

function listRows(state: DashboardState, snapshot: Snapshot): SidebarRow[] {
  if (state.tab === "sessions") return sessionListRows(state, snapshot)
  if (state.tab === "terminals")
    return snapshot.terminals.map((terminal) => ({
      id: terminal.id,
      name: `[${label(terminal.status)}] ${label(terminal.title)}`,
      description: `PID ${terminal.pid} · ${label(terminal.cwd, 250)}`,
    }))
  return snapshot.loops.map((loop) => ({
    id: loop.id,
    name: `[${label(loop.status)}] ${label(loop.name)}`,
    description: `${scheduleText(loop.schedule, loop.eventTrigger)} · ${label(loop.location.directory, 250)}`,
  }))
}

function sessionListRows(state: DashboardState, snapshot: Snapshot): SidebarRow[] {
  return sessionRows(
    snapshot.sessions.filter(
      (session) =>
        snapshot.workingFolders === undefined ||
        snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory)) ||
        state.selected === session.id ||
        state.modal?.recipient?.id === session.id,
    ),
    snapshot.active,
    snapshot.needsInput,
  ).map((row) => {
    const session = snapshot.sessions.find((session) => session.id === row.id)!
    return snapshot.workingFolders !== undefined &&
      !snapshot.workingFolders.some((folder) => folderContains(folder, session.location.directory))
      ? { ...row, groupLabel: `${row.groupLabel} (closed)` }
      : row
  })
}

function matching(state: DashboardState, rows: SidebarRow[]) {
  return rows.filter((row) =>
    state.tab === "sessions" && state.inspection && state.query === state.inspection
      ? row.id === state.inspection
      : `${row.name} ${row.description} ${row.id}`.toLowerCase().includes(state.query.toLowerCase()),
  )
}

function defaultSelection(d: DashboardContext, snapshot: Snapshot) {
  if (d.state.tab !== "sessions") return ""
  const requested = snapshot.sessions.find((session) => session.id === d.options.session)
  return (requested ?? snapshot.sessions.find((session) => !session.parentID) ?? snapshot.sessions[0])?.id
}

function renderSidebar(d: DashboardContext, snapshot: Snapshot) {
  renderSidebarTitle(d)
  renderEmptyList(d)
  d.ui.folders.content = ` Working folders · ${foldersState(snapshot)}`
  const emptyFolders = (snapshot.workingFolders ?? []).filter(
    (directory) => !snapshot.sessions.some((session) => folderContains(directory, session.location.directory)),
  )
  d.ui.emptyFolders.visible = d.state.tab === "sessions" && emptyFolders.length > 0
  d.ui.emptyFolders.height = Math.min(3, emptyFolders.length)
  d.ui.emptyFolders.content = emptyFolders
    .slice(0, 3)
    .map((directory) => `${label(directory, 250)} (no recent sessions)`)
    .join("\n")
  d.ui.heading.content = d.renderer.width < 90 ? "TurenOS" : headerLeft(snapshot)
  d.ui.running.content = headerRight(d.state, snapshot)
}

/** What the row says about the open folders: a server with no stored list shows every session folder. */
function foldersState(snapshot: Snapshot) {
  if (snapshot.folderError) return "cannot sync"
  return snapshot.workingFolders ? `${snapshot.workingFolders.length} open` : "all shown"
}

/** The note line above the list: why it is empty, else what the `*` and `?` markers on its rows mean. */
function renderEmptyList(d: DashboardContext) {
  const rows = d.state.rows as SidebarRow[]
  const legend = [
    rows.some((row) => row.running) ? "* running" : "",
    rows.some((row) => row.needsInput) ? "? needs input" : "",
  ].filter(Boolean)
  d.ui.emptyList.visible = rows.length === 0 || legend.length > 0
  // The notes are cut by the sidebar's 28 columns, so they stay under that.
  d.ui.emptyList.content = rows.length
    ? legend.join(" · ")
    : d.state.query
      ? "Nothing matches the filter."
      : d.state.tab === "sessions"
        ? "No sessions. n starts one."
        : d.state.tab === "terminals"
          ? "No terminals. a opens one."
          : "No automations. a adds one."
}
