import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import type { Connection } from "./server"
import type { DashboardState } from "./state"
import { open, shared } from "./terminals/attach"
import { close, create, rename } from "./terminals/dialogs"

/**
 * Server terminals, as in the desktop's terminal panel: attach full-screen (Ctrl+] detaches and
 * leaves the process running), open new ones, rename or close them, and join a session's shared
 * terminal that the agent's terminal tool also uses.
 */
export function createTerminals(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  refresh: () => Promise<void>,
) {
  const ctx = { renderer, state, connection, dialogs, say, refresh }
  return {
    open: () => open(ctx),
    shared: () => shared(ctx),
    create: () => create(ctx),
    rename: () => rename(ctx),
    close: () => close(ctx),
  }
}
