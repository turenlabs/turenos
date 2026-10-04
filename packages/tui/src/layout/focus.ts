import type { CliRenderer } from "@opentui/core"
import { statusline } from "../chrome"
import { color } from "../theme"
import type { DashboardState } from "../state"
import type { LayoutParts } from "./parts"

/** Tracks which pane has focus when the user focuses the list or transcript directly. */
export function watchPaneFocus(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  for (const pane of [parts.list, parts.detail])
    pane.on("focused", () => {
      if (state.modal || state.searching) return
      state.detailFocused = pane === parts.detail
      showFocusedPane(renderer, state, parts)
      renderer.setCursorPosition(0, 0, false)
    })
}

/** Moves focus to the search box, the transcript or the session list, as the state requires. */
export function focusLayout(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  if (state.closed || state.modal) return
  if (state.searching) return parts.search.focus()
  if (!parts.sidebar.visible) state.detailFocused = true
  if (state.detailFocused) parts.detail.focus()
  if (!state.detailFocused) parts.list.focus()
  renderer.setCursorPosition(0, 0, false)
  showFocusedPane(renderer, state, parts)
}

function showFocusedPane(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  parts.footer.content = statusline(state, state.snapshot, renderer.width)
  parts.sidebarHeading.fg = state.detailFocused ? color.muted : color.accent
  parts.actions.borderColor = state.detailFocused ? color.focus : color.border
}
