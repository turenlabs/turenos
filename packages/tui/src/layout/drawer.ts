import type { CliRenderer } from "@opentui/core"
import { layout } from "../theme"
import type { DashboardState } from "../state"
import type { LayoutParts } from "./parts"

/**
 * Adjusts what `resizeLayout` set for the narrow drawer (the sidebar opened under the transcript below
 * the narrow breakpoint): the drawer lines up with the composer box above it, shows its heading, and
 * is as tall as its rows need, up to half of the screen, so a long list is not cut to three rows.
 * The running state in the top bar shows at every width.
 */
export function fitDrawer(renderer: CliRenderer, state: DashboardState, parts: LayoutParts) {
  const drawer = renderer.width < layout.narrowBreakpoint && parts.sidebar.visible && !state.modal?.sidebar
  parts.running.visible = parts.running.plainText.length > 0
  parts.sidebar.marginLeft = drawer ? 1 : 0
  if (!drawer) return
  parts.sidebarHeading.visible = true
  // Wide enough for the margin; the default 100% would push the drawer one column past the edge.
  parts.sidebar.width = renderer.width - 5
  // Heading, view switch and the two actions, the note line when shown, then the list with its project headings.
  const rows = state.rows as { group?: string }[]
  const needed = 4 + (parts.emptyList.visible ? 1 : 0) + rows.length + new Set(rows.map((row) => row.group)).size
  parts.sidebar.height = Math.max(7, Math.min(needed, Math.floor((renderer.height - 4) / 2) + 1))
}
