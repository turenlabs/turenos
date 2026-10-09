import { BoxRenderable, type CliRenderer } from "@opentui/core"
import { color } from "./theme"
import type { DashboardState } from "./state"
import { createFooter, createSizeNotice } from "./layout/footer"
import { focusLayout, watchPaneFocus } from "./layout/focus"
import { createMain } from "./layout/main"
import type { LayoutParts } from "./layout/parts"
import { fitDrawer } from "./layout/drawer"
import { resizeLayout } from "./layout/resize"
import { createSidebar, createTabButtons } from "./layout/sidebar"
import { createTopbar } from "./layout/topbar"

export function createLayout(renderer: CliRenderer, state: DashboardState) {
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 2,
    paddingTop: 1,
    backgroundColor: color.bg,
  })
  renderer.root.add(root)
  const topbar = createTopbar(renderer, root)
  const tabButtons = createTabButtons(renderer)
  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 1, gap: 2 })
  root.add(body)
  const sidebar = createSidebar(renderer, tabButtons)
  const main = createMain(renderer, body, () => state.reducedMotion)
  body.add(sidebar.sidebar)
  const footer = createFooter(renderer, root)
  const size = createSizeNotice(renderer, root)
  const parts: LayoutParts = { root, body, tabButtons, ...topbar, ...sidebar, ...main, ...footer, ...size }
  watchPaneFocus(renderer, state, parts)
  renderer.setCursorPosition(0, 0, false)
  const armed = { quit: false }
  return exposedLayout(parts, {
    // A resize that does not know about the quit (a dialog opening) keeps the last one it was told.
    resize: (quitArmed = armed.quit) => {
      armed.quit = quitArmed
      resizeLayout(renderer, state, parts, quitArmed)
      fitDrawer(renderer, state, parts)
    },
    focus: () => focusLayout(renderer, state, parts),
  })
}

export type DashboardLayout = ReturnType<typeof createLayout>

// The parts the dashboard may use; `body`, the footer row, shortcuts and the size text stay internal.
function exposedLayout(parts: LayoutParts, actions: { resize: (quitArmed?: boolean) => void; focus: () => void }) {
  return {
    root: parts.root,
    main: parts.main,
    heading: parts.heading,
    server: parts.server,
    running: parts.running,
    modelButton: parts.modelButton,
    switchButton: parts.switchButton,
    serversButton: parts.serversButton,
    status: parts.status,
    tabButtons: parts.tabButtons,
    sidebar: parts.sidebar,
    sidebarHeading: parts.sidebarHeading,
    sidebarActions: parts.sidebarActions,
    search: parts.search,
    folders: parts.folders,
    emptyFolders: parts.emptyFolders,
    emptyList: parts.emptyList,
    list: parts.list,
    sessionTitle: parts.sessionTitle,
    context: parts.context,
    activity: parts.activity,
    historyActions: parts.historyActions,
    older: parts.older,
    newer: parts.newer,
    historyCount: parts.historyCount,
    detail: parts.detail,
    actions: parts.actions,
    composer: parts.composer,
    stop: parts.stop,
    history: parts.history,
    information: parts.information,
    changes: parts.changes,
    files: parts.files,
    tasks: parts.tasks,
    queued: parts.queued,
    harness: parts.harness,
    meter: parts.meter,
    notice: parts.notice,
    footer: parts.footer,
    sizeNotice: parts.sizeNotice,
    resize: actions.resize,
    focus: actions.focus,
    renderContent: parts.renderContent,
  }
}
