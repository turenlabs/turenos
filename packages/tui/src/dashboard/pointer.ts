import type { MouseEvent } from "@opentui/core"
import { primaryAction, renderActions } from "./actions"
import { changeTab, filter } from "./navigation"
import { renderList } from "./list"
import { openServers } from "./lifecycle"
import type { DashboardContext } from "./context"

/** Wires the clickable chrome, the sidebar search box and the sidebar list to their actions. */
export function bindPointer(d: DashboardContext) {
  bindButtons(d)
  bindActionRow(d)
  bindSearch(d)
  bindList(d)
  bindTranscript(d)
}

/**
 * A press on the transcript holds the reply editor shut until release. Opening it mid-drag docks it under the
 * transcript, shifts the rows and drops the selection; a plain click still lets it open afterwards.
 */
function bindTranscript(d: DashboardContext) {
  const detail = d.ui.detail
  const handle = detail.onMouse
  let held: { navigating: boolean; dragged: boolean } | undefined
  detail.onMouse = (event) => {
    handle?.call(detail, event)
    if (event.type === "down" && event.button === 0 && !d.state.modal) {
      held = { navigating: held?.navigating ?? d.state.navigating, dragged: false }
      d.state.navigating = true
      return
    }
    if (!held) return
    if (event.type === "drag") held.dragged = true
    if (event.type !== "up" && event.type !== "drag-end") return
    if (!held.dragged) d.state.navigating = held.navigating
    held = undefined
  }
}

/** A left-button press that runs `action`; any press disarms a pending quit confirmation. */
function onPress(d: DashboardContext, action: () => void) {
  return (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    d.run.quitArmedUntil = 0
    action()
  }
}

function bindButtons(d: DashboardContext) {
  const ui = d.ui
  ui.switchButton.onMouseDown = onPress(d, () => d.c.menus.switcher())
  ui.server.onMouseDown = onPress(d, () => openServers(d))
  ui.serversButton.onMouseDown = onPress(d, () => openServers(d))
  ui.folders.onMouseDown = onPress(d, () => d.c.menus.workingFolders())
  ui.modelButton.onMouseDown = onPress(d, () => {
    if (d.state.modal) {
      if (!d.state.modal.busy) d.state.modal.chooseModel?.()
      return
    }
    d.c.models.open()
  })
  for (const { tab, button } of ui.tabButtons) button.onMouseDown = onPress(d, () => changeTab(d, tab))
  ui.sidebarActions.onMouseDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    d.run.quitArmedUntil = 0
    if (event.y === ui.sidebarActions.y) addAction(d)
    if (event.y === ui.sidebarActions.y + 1) filter(d)
  }
}

/** The first sidebar entry: new session, terminal or automation, as the open tab calls for. */
function addAction(d: DashboardContext) {
  if (d.state.tab === "terminals") return d.c.terminals.create()
  if (d.state.tab === "automations") return d.c.automations.create()
  d.c.launch.open()
}

function bindActionRow(d: DashboardContext) {
  const ui = d.ui
  const unlessModal = (action: () => void) => onPress(d, () => !d.state.modal && action())
  ui.composer.onMouseDown = onPress(d, () => primaryAction(d))
  ui.history.onMouseDown = unlessModal(() => d.c.conversation.toggleHistory())
  ui.older.onMouseDown = onPress(d, () => d.c.conversation.page("next"))
  ui.newer.onMouseDown = onPress(d, () => d.c.conversation.page("previous"))
  ui.information.onMouseDown = unlessModal(() => d.c.menus.information(d.serverAddress))
  ui.stop.onMouseDown = unlessModal(() => d.c.requests.interrupt())
  ui.tasks.onMouseDown = unlessModal(() => d.c.sessions.tasks())
  ui.harness.onMouseDown = unlessModal(() => d.c.harness.open())
  ui.queued.onMouseDown = unlessModal(() => d.c.queue.open())
  ui.changes.onMouseDown = unlessModal(() => d.c.changes.open())
  ui.files.onMouseDown = unlessModal(() => d.c.files.open())
}

function bindSearch(d: DashboardContext) {
  d.ui.search.on("input", () => {
    if (!d.state.searching) return
    d.state.query = d.ui.search.value
    renderList(d)
    d.state.detail = undefined
    void d.c.conversation.render()
  })
}

function bindList(d: DashboardContext) {
  const state = d.state
  const ui = d.ui
  ui.list.on("selectionChanged", (index: number) => {
    if (d.run.renderingList) return
    d.run.quitArmedUntil = 0
    const id = state.rows[index]?.id ?? ""
    if (id === state.selected) return
    if (!d.c.dialogs.navigate()) {
      ui.list.setSelectedIndex(
        Math.max(
          0,
          state.rows.findIndex((row) => row.id === state.selected),
        ),
      )
      state.modal?.fields[state.modal.index]?.focus()
      return
    }
    d.c.conversation.rememberPosition()
    if (state.tab === "sessions") state.previousSession = state.selected
    state.selected = id
    d.c.conversation.loadPosition()
    renderActions(d)
    state.detail = undefined
    if (!d.c.conversation.hasLive(id) || state.tab !== "sessions") {
      ui.renderContent("Loading session…")
    }
    void d.c.conversation.render()
  })
  ui.list.on("itemSelected", () => {
    if (state.modal) return
    // Enter on a session goes into it, so typing goes to its reply editor at once.
    state.detailFocused = true
    state.navigating = false
    ui.focus()
    renderActions(d)
    // Terminals attach and automations open their menu at once, as the detail pane's Enter does.
    if (state.tab !== "sessions" && state.selected) primaryAction(d)
  })
  ui.list.on("focused", () => {
    const dialog = state.modal
    if (dialog) (dialog.fields[dialog.index] ?? dialog.form).focus()
  })
}
