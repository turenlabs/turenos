import type { CliRenderer } from "@opentui/core"
import type { Connection } from "../server"
import { createDashboardState } from "../state"
import { createLayout } from "../layout"
import { createControls } from "./controls"
import { bindPointer } from "./pointer"
import { attach } from "./lifecycle"
import { renderList } from "./list"
import { refresh } from "./refresh"
import { openSession } from "./navigation"
import { resize, say } from "./status"
import type { Controls, DashboardContext, DashboardOptions } from "./context"

export function mountDashboard(
  renderer: CliRenderer,
  connection: Connection,
  address: string,
  onQuit = () => renderer.destroy(),
  options: DashboardOptions = {},
) {
  const d = createContext(renderer, connection, address, onQuit, options)
  createControls(d)
  bindPointer(d)
  const listeners = attach(d)
  resize(d)
  renderList(d)
  d.c.live.start()
  const ready = refresh(d)
  return {
    ready,
    refresh: () => refresh(d),
    dispose: listeners.dispose,
    connected: () => d.state.connected,
    drafts: () =>
      (d.c.launch.hasDraft ? 1 : 0) +
      d.c.requests.savedSessions().length +
      (d.state.modal?.editor?.plainText.trim() ? 1 : 0),
    focus() {
      const dialog = d.state.modal
      if (dialog) return (dialog.fields[dialog.index] ?? dialog.form).focus()
      d.ui.focus()
    },
  }
}

export type Dashboard = ReturnType<typeof mountDashboard>

function createContext(
  renderer: CliRenderer,
  connection: Connection,
  address: string,
  onQuit: () => void,
  options: DashboardOptions,
) {
  const state = createDashboardState()
  state.serverSwitching = !!options.servers
  const ui = createLayout(renderer, state)
  ui.serversButton.visible = !!options.servers
  const d: DashboardContext = {
    renderer,
    connection,
    state,
    ui,
    options,
    serverAddress: options.server ? `${options.server} · ${address}` : address,
    onQuit,
    run: {
      timer: undefined,
      refreshing: undefined,
      noticeTimer: undefined,
      noticeMessage: "",
      activityTimer: undefined,
      activityStep: 0,
      renderingList: false,
      quitArmedUntil: 0,
      disposed: false,
      views: new Map(),
      listeners: undefined,
    },
    // Installed group by group by createControls before anything can read it.
    c: {} as Controls,
    say: (message, error) => say(d, message, error),
    openSession: (id, inspect, session) => openSession(d, id, inspect, session),
    refresh: () => refresh(d),
  }
  return d
}
