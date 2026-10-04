import type { CliRenderer } from "@opentui/core"
import { color, layout } from "../theme"
import type { DashboardState } from "../state"
import { footerShortcuts } from "../chrome"
import { folderContains } from "../working-folders"
import type { LayoutParts } from "./parts"

/** Re-applies size- and modal-dependent visibility and dimensions to every part. */
export function resizeLayout(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  const narrow = renderer.width < layout.narrowBreakpoint
  resizeSizeNotice(renderer, state, parts)
  resizeTopbar(renderer, state, parts)
  resizeBody(parts, narrow)
  resizeSidebar(renderer, state, parts, narrow)
  resizeMain(state, parts, narrow)
  resizeDockedModal(renderer, state)
  parts.footerRow.visible = !state.modal
  parts.shortcuts.content = footerShortcuts(renderer.width, parts.sidebar.visible)
}

function resizeSizeNotice(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  parts.sizeNotice.visible = renderer.width < layout.minWidth || renderer.height < layout.minHeight
  parts.sizeText.content = `Resize the terminal\n\nTurenOS needs at least ${layout.minWidth} columns × ${layout.minHeight} rows.\nCurrent size: ${renderer.width} × ${renderer.height}.\n\n${state.modal ? "Your draft stays open while you resize.\n" : ""}q / Ctrl+C quits.`
}

function resizeTopbar(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  parts.running.visible = renderer.width >= 70
  parts.modelButton.content = state.modal ? (state.modal.chooseModel ? "Models Ctrl+L" : "Models") : "Models m"
  parts.modelButton.fg = !state.modal || (state.modal.chooseModel && !state.modal.busy) ? color.accent : color.muted
  parts.switchButton.content = state.modal ? "Sessions" : "Sessions Ctrl+K"
  parts.switchButton.fg = !state.modal || (state.modal.save && !state.modal.busy) ? color.accent : color.muted
  parts.serversButton.content = state.modal ? "Servers" : "Servers s"
  parts.serversButton.fg = state.modal?.busy ? color.muted : color.accent
}

function resizeBody(parts: LayoutParts, narrow: boolean) {
  parts.body.flexDirection = narrow ? "column" : "row"
  parts.body.gap = narrow ? 1 : 2
}

function resizeSidebar(renderer: CliRenderer, state: DashboardState, parts: LayoutParts, narrow: boolean) {
  parts.sidebar.visible =
    !!state.modal?.sidebar ||
    (!(state.sidebarHidden ?? narrow) && !state.modal?.inline && !(narrow && state.modal?.docked))
  parts.sidebarHeading.visible = !narrow
  parts.folders.visible = !narrow
  parts.emptyFolders.visible =
    !narrow &&
    state.tab === "sessions" &&
    (state.snapshot?.workingFolders ?? []).some(
      (directory) => !state.snapshot?.sessions.some((session) => folderContains(directory, session.location.directory)),
    )
  parts.sidebar.paddingTop = 0
  parts.sidebar.paddingBottom = 0
  parts.sidebar.width = narrow
    ? "100%"
    : state.modal?.sidebar
      ? Math.min(80, Math.max(48, Math.floor(renderer.width * 0.45)))
      : Math.min(56, Math.max(layout.sidebarWidth, Math.floor(renderer.width * 0.3)))
  parts.sidebar.height =
    narrow && !state.modal?.sidebar ? Math.max(6, Math.min(10, Math.round((renderer.height - 4) / 3))) : "100%"
  parts.sidebar.flexShrink = 0
}

function resizeMain(state: DashboardState, parts: LayoutParts, narrow: boolean) {
  parts.main.width = narrow ? "100%" : "auto"
  parts.main.visible = !(narrow && state.modal?.sidebar)
  parts.main.height = narrow && parts.sidebar.visible ? "auto" : "100%"
  parts.sessionTitle.visible = !state.modal?.inline
  parts.context.visible = !state.modal?.inline && !!state.selected
  parts.historyActions.visible = state.tab === "sessions" && state.history && !!state.selected && !state.modal?.inline
  parts.actions.visible = !state.modal && parts.composer.visible
}

function resizeDockedModal(renderer: CliRenderer, state: DashboardState) {
  if (!state.modal?.docked) return
  const editorHeight = state.modal.editor ? Math.max(3, Math.min(6, state.modal.editor.lineInfo.lineSources.length)) : 0
  state.modal.box.height = Math.min(
    Math.floor(renderer.height / 2),
    state.modal.editor
      ? editorHeight + state.modal.error.height + 3 + (state.modal.suggestionRows ?? 0) + (state.modal.mentionRows ?? 0)
      : state.modal.height,
  )
}
