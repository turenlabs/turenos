import { clearTitle, renderActivity, renderAttention, resize } from "./status"
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

export function toggleAttention(d: DashboardContext) {
  // Turning it off takes the title it set with it; on again, the title returns at once.
  if (d.state.attention) clearTitle(d)
  d.state.attention = !d.state.attention
  renderAttention(d)
  d.say(d.state.attention ? "Bell and terminal title on." : "Bell and terminal title off.")
}

export function toggleSidebar(d: DashboardContext) {
  d.state.sidebarHidden = d.ui.sidebar.visible
  // An opened sidebar takes the keys, so the footer's "Focus: sidebar" is true.
  if (!d.state.sidebarHidden) d.state.detailFocused = false
  resize(d)
}
