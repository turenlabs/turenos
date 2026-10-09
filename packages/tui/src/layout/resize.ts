import type { CliRenderer, Renderable } from "@opentui/core"
import { color, layout } from "../theme"
import type { DashboardState } from "../state"
import { footerShortcuts, statusline } from "../chrome"
import { folderContains } from "../working-folders"
import { sizeFloating } from "../dialogs/size"
import type { LayoutParts } from "./parts"

/** The side-by-side sidebar's width: 30% of the screen within its minimum and 56 columns. */
export function sidebarColumns(width: number) {
  return Math.min(56, Math.max(layout.sidebarWidth, Math.floor(width * 0.3)))
}

/** Re-applies size- and modal-dependent visibility and dimensions to every part. */
export function resizeLayout(renderer: CliRenderer, state: DashboardState, parts: LayoutParts, quitArmed = false) {
  const narrow = renderer.width < layout.narrowBreakpoint
  resizeSizeNotice(renderer, state, parts)
  resizeTopbar(state, parts)
  resizeBody(parts, narrow)
  resizeSidebar(renderer, state, parts, narrow)
  resizeMain(state, parts, narrow)
  resizeDockedModal(renderer, state)
  // The reply editor stays open while typing, so the footer stays with it.
  parts.footerRow.visible = !state.modal || !!state.modal.composer
  // Ctrl+C stops the selected session's running turn before it quits, so the hint follows that.
  const running = !!state.selected && Object.hasOwn(state.snapshot?.active ?? {}, state.selected)
  // Narrow footers share the row: the shortcuts take what the status text on the left leaves.
  const left = statusline(state, state.snapshot, renderer.width).length
  parts.shortcuts.content = footerShortcuts(
    renderer.width,
    parts.sidebar.visible,
    !!state.modal?.composer,
    running,
    quitArmed,
    left,
  )
}

function resizeSizeNotice(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  parts.sizeNotice.visible = renderer.width < layout.minWidth || renderer.height < layout.minHeight
  parts.sizeText.content = `Resize the terminal\n\nTurenOS needs at least ${layout.minWidth} columns × ${layout.minHeight} rows.\nCurrent size: ${renderer.width} × ${renderer.height}.\n\n${state.modal ? "Your draft stays open while you resize.\n" : ""}q / Ctrl+C quits.`
}

function resizeTopbar(state: DashboardState, parts: LayoutParts) {
  parts.modelButton.content = state.modal ? (state.modal.chooseModel ? "Models Ctrl+L" : "Models") : "Models m"
  parts.modelButton.fg = !state.modal || (state.modal.chooseModel && !state.modal.busy) ? color.accent : color.muted
  // A dialog that keeps a draft lets the key through once Esc has set the draft aside; the reply editor, which
  // is open in every session view, passes Ctrl+K straight through. Other dialogs keep the label short.
  const afterEsc = !!state.modal?.save && !state.modal.composer
  const direct = !state.modal || !!state.modal.composer
  // "Esc" and the key are two steps, so they sit in one parenthesis rather than reading as a two-key chord.
  parts.switchButton.content = direct ? "Sessions Ctrl+K" : afterEsc ? "Sessions (Esc, Ctrl+K)" : "Sessions"
  parts.switchButton.fg = direct || (state.modal?.save && !state.modal.busy) ? color.accent : color.muted
  parts.serversButton.content = state.modal && !afterEsc ? "Servers" : `Servers ${afterEsc ? "(Esc, s)" : "s"}`
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
      : sidebarColumns(renderer.width)
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
  parts.actions.visible = state.modal ? !!state.modal.composer : parts.composer.visible
}

function resizeDockedModal(renderer: CliRenderer, state: DashboardState) {
  const modal = state.modal
  if (!modal) return
  sizeFloating(renderer, modal)
  if (!modal.docked) return
  if (!modal.editor) {
    // A request dialog is as tall as its content, up to all but the top rows.
    const cap = Math.max(Math.floor(renderer.height / 2), renderer.height - 10)
    modal.box.height = "auto"
    modal.box.maxHeight = cap
    modal.frame.height = "auto"
    modal.frame.maxHeight = cap
    return
  }
  // A reply editor keeps the lower half and is as tall as its wrapped text, 1-6 rows, counted from
  // lineSources (virtualLineCount can be viewport-limited). Set here as well as by followText:
  // text set programmatically does not fire the content-change hook.
  const editorHeight = Math.max(1, Math.min(6, modal.editor.lineInfo.lineSources.length))
  modal.editor.height = editorHeight
  modal.frame.height = "100%"
  modal.box.height = Math.min(
    Math.floor(renderer.height / 2),
    // The heading row; an editor that is not the docked reply also has its caption and Send button.
    editorHeight +
      requestedHeight(modal.error) +
      (modal.composer ? 1 : 3) +
      (modal.suggestionRows ?? 0) +
      (modal.mentionRows ?? 0) +
      (modal.attachmentRows ?? 0),
  )
}

/** The height just assigned: a renderable's `height` getter keeps the previous layout until the next render. */
function requestedHeight(node: Renderable) {
  const height = node.getLayoutNode().getHeight().value
  return Number.isFinite(height) ? height : node.height
}
