import type { CliRenderer } from "@opentui/core"
import { httpStatus, type Connection } from "../server"
import { createDashboardState, label } from "../state"
import { createLayout } from "../layout"
import { FolderNotFound, resolveFolder } from "../working-folders"
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
  const ready = startIn(d, options.folder).then(async (note) => {
    await refresh(d)
    if (note && !d.state.closed) d.say(note)
    const id = options.session
    if (!id || d.state.snapshot?.sessions.some((session) => session.id === id)) return
    // Older than the snapshot's window: fetch it like a pasted link would.
    void d.connection.client.sessions.get({ sessionID: id }).then(
      (session) => !d.state.closed && d.openSession(id, false, session),
      () => !d.state.closed && d.say(`No session ${id} on this server. Showing the newest session.`, true),
    )
  })
  return {
    ready,
    refresh: () => refresh(d),
    dispose: listeners.dispose,
    connected: () => d.state.connected,
    drafts: () =>
      (d.c.launch.hasDraft ? 1 : 0) +
      d.c.requests.unsentDrafts() +
      d.c.team.unsent() +
      (!d.state.modal?.composer && d.state.modal?.editor?.plainText.trim() ? 1 : 0),
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
      noticeScope: undefined,
      activityTimer: undefined,
      activityStep: 0,
      renderingList: false,
      quitArmedUntil: 0,
      quitDiscards: false,
      shortcutsFor: "",
      quitTimer: undefined,
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

/**
 * Shows the folder the dashboard starts in before the first snapshot, so the list never flashes every folder. A folder
 * the server cannot read is dropped, and the returned note says why every folder shows. A refused credential or a
 * lost connection drops it without a note: the first snapshot reports those.
 */
async function startIn(d: DashboardContext, directory: string | undefined) {
  if (!directory) return
  const result = await resolveFolder(d.connection.client, directory).then(
    (folder) => ({ folder, unreadable: false }),
    (error: unknown) => {
      const status = httpStatus(error)
      const unreadable = status === undefined ? error instanceof FolderNotFound : status !== 401 && status !== 403
      return { folder: undefined, unreadable }
    },
  )
  if (d.state.closed) return
  if (result.folder) d.state.folder = result.folder
  return result.unreadable ? `Showing every folder: ${label(directory, 200)} is not readable on this server.` : undefined
}
