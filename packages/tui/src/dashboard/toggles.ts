import { renderActivity, resize } from "./status"
import type { DashboardContext } from "./context"

export function toggleRaw(d: DashboardContext) {
  d.state.rawResponses = !d.state.rawResponses
  void d.c.conversation.render()
  d.say(d.state.rawResponses ? "Raw responses on." : "Formatted responses on.")
}

export function toggleMotion(d: DashboardContext) {
  d.state.reducedMotion = !d.state.reducedMotion
  renderActivity(d)
  d.say(d.state.reducedMotion ? "Reduced motion on." : "Reduced motion off.")
}

export function toggleSidebar(d: DashboardContext) {
  d.state.sidebarHidden = d.ui.sidebar.visible
  // An opened sidebar takes the keys, so the footer's "Focus: sidebar" is true.
  if (!d.state.sidebarHidden) d.state.detailFocused = false
  resize(d)
}
