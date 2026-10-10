import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { createFlow } from "./model-connections/flow"
import { load } from "./model-connections/provider-list"
import type { Connection } from "./server"
import type { DashboardState } from "./state"

export function createModelConnections(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  function open(directory: string, done: () => void): void {
    if (state.modal || state.closed) return
    load(createFlow({ renderer, state, connection, dialogs, say }, directory, done, load))
  }

  return { open }
}
