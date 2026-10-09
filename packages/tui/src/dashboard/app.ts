import type { CliRenderer } from "@opentui/core"
import { connect } from "../server"
import { serverLabel, type Endpoint, type Servers, type Target } from "../servers"
import { createServerPicker } from "../server-picker"
import { onThisComputer } from "../working-folders"
import { mountDashboard, type Dashboard } from "./mount"

/**
 * The connected dashboard, and the directory and session the next connection starts in (only the first server gets
 * them). `startFolder` is the folder the client was started in, shown on every server on this computer.
 */
type App = {
  current: { dashboard: Dashboard; endpoint: Endpoint } | undefined
  directory: string | undefined
  session: string | undefined
  startFolder: string | undefined
}

/** The server picker plus one dashboard for the connected server, swapped as the user switches. */
export function mountApp(
  renderer: CliRenderer,
  servers: Servers,
  options: {
    initial?: Target
    directory?: string
    session?: string
    startFolder?: string
    onQuit: (drafts: number) => void
  },
) {
  const app: App = {
    current: undefined,
    directory: options.directory,
    session: options.session,
    startFolder: options.startFolder,
  }
  const picker = createServerPicker(renderer, servers, {
    current: () => app.current && { target: app.current.endpoint.target, connected: app.current.dashboard.connected() },
    drafts: () => app.current?.dashboard.drafts() ?? 0,
    connect: (target, signal, progress) =>
      connectDashboard({ renderer, servers, app, picker, finish }, target, signal, progress),
    closed: () => app.current?.dashboard.focus(),
    quit: finish,
  })

  function dispose() {
    picker.close(false)
    app.current?.dashboard.dispose()
    app.current?.endpoint.close?.()
    app.current = undefined
    servers.stopHeadless()
  }

  function finish() {
    const drafts = app.current?.dashboard.drafts() ?? 0
    dispose()
    options.onQuit(drafts)
  }

  if (options.initial) picker.start(options.initial)
  else
    picker.open(
      servers.problems().join(" ") ||
        "TurenOS is not running on this computer. Open the TurenOS app, start a private server, or choose another server.",
      "warning",
    )
  return { picker, dashboard: () => app.current?.dashboard, dispose }
}

async function connectDashboard(
  host: {
    renderer: CliRenderer
    servers: Servers
    app: App
    picker: ReturnType<typeof createServerPicker>
    finish: () => void
  },
  target: Target,
  signal: AbortSignal,
  progress: (text: string) => void,
) {
  const endpoint = await host.servers.resolve(target, { signal, progress })
  if (signal.aborted) {
    endpoint.close?.()
    throw new Error("Connection cancelled.")
  }
  const connection = open(endpoint, host.app.directory)
  // Mount before disposing the current dashboard, so a failed switch leaves it untouched.
  let dashboard: Dashboard
  try {
    dashboard = mountDashboard(host.renderer, connection, endpoint.url, host.finish, {
      server: serverLabel(endpoint.target),
      servers: (back) => host.picker.open(undefined, "muted", back),
      blocked: host.picker.visible,
      session: host.app.session,
      folder: host.app.directory ?? (onThisComputer(target) ? host.app.startFolder : undefined),
    })
  } catch (error) {
    connection.close()
    endpoint.close?.()
    throw error
  }
  host.app.directory = undefined
  host.app.session = undefined
  const previous = host.app.current
  host.app.current = { endpoint, dashboard }
  previous?.dashboard.dispose()
  previous?.endpoint.close?.()
  void host.servers.importDesktop(endpoint)
}

/** The connection for a verified endpoint; a refused configuration releases the endpoint's tunnel. */
function open(endpoint: Endpoint, directory: string | undefined) {
  try {
    return connect({ url: endpoint.url, username: endpoint.username, password: endpoint.password, directory })
  } catch (error) {
    endpoint.close?.()
    throw error
  }
}
