import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { overview } from "./harness/overview"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

/**
 * The session harness the server runs for every session: its active snapshot (tools and standing
 * guidance), the automatic reviewer's runs, and the proposals it made. Opening it is read-only;
 * each change is a separate confirmation, like the desktop's Harness panel.
 */
export function createHarnessControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  blocked: (id: string) => boolean,
) {
  const ctx = { renderer, state, connection, dialogs, say, blocked }
  return {
    open() {
      const session =
        state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
      if (!session) return say("Select a created session first.", true)
      if (state.closed || !dialogs.navigate()) return
      if (!state.connected) return say("Reconnect before opening the harness.", true)
      overview(ctx, structuredClone(session))
    },
  }
}
