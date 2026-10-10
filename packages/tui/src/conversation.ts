import type { MessagesListOutput } from "@turenlabs/client"
import type { DashboardLayout } from "./layout"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import {
  invalidateAll,
  invalidateSession,
  loadPosition,
  page,
  toggleHistory,
  toggleToolOutput,
  updateLive,
} from "./conversation/actions"
import { newConversation, type ConversationHooks } from "./conversation/context"
import { cancelPosition, scrollEarlier } from "./conversation/earlier"
import { render } from "./conversation/load"
import { installTextAnchor, rememberPosition, restorePosition } from "./conversation/position"

export function createConversation(
  state: DashboardState,
  connection: Connection,
  ui: DashboardLayout,
  hooks: ConversationHooks,
) {
  const c = newConversation(state, connection, ui, hooks)
  const renderAfter = installTextAnchor(c)
  const restore = () => restorePosition(c)
  ui.detail.content.on("resize", restore)
  ui.detail.viewport.on("resize", restore)
  ui.detail.onMouse = (event) => {
    if (["scroll", "down", "drag"].includes(event.type)) cancelPosition(c)
    if (event.type === "scroll" && event.scroll?.direction === "up") void scrollEarlier(c)
  }
  // Slider-specific handlers stop propagation; keep them and observe input first.
  ui.detail.verticalScrollBar.slider.onMouse = (event) => {
    if (["down", "drag"].includes(event.type)) cancelPosition(c)
  }

  return {
    render: () => render(c),
    updateLive: (messages: MessagesListOutput["data"]) => updateLive(c, messages),
    invalidateSession: (sessionID: string) => invalidateSession(c, sessionID),
    invalidateAll: () => invalidateAll(c),
    rememberPosition: () => rememberPosition(c),
    loadPosition: () => loadPosition(c),
    hasLive: (id: string) => c.live.has(id),
    cancelPosition: () => cancelPosition(c),
    scrollEarlier: () => scrollEarlier(c),
    toggleHistory: () => toggleHistory(c),
    toggleToolOutput: () => toggleToolOutput(c),
    page: (direction: "next" | "previous") => page(c, direction),
    dispose() {
      c.disposed = true
      ++state.detailVersion
      c.generation++
      c.live.clear()
      ui.detail.renderAfter = renderAfter
      c.textAnchor = undefined
      ui.detail.content.off("resize", restore)
      ui.detail.viewport.off("resize", restore)
    },
    get error() {
      return c.error
    },
  }
}
