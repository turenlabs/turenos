import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { createModelConnections } from "./model-connections"
import { pick } from "./models/pick"
import { pickForSession } from "./models/session-model"
import type { ModelsContext, ModelTarget } from "./models/types"
import type { Connection, Session } from "./server"
import type { DashboardState } from "./state"

export function createModels(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  onUpdate: (session: Session) => void = () => {},
  blocked: (sessionID: string) => boolean = () => false,
) {
  const connections = createModelConnections(renderer, state, connection, dialogs, say)
  const ctx: ModelsContext = {
    renderer,
    state,
    connection,
    dialogs,
    say,
    onUpdate,
    blocked,
    connectProvider: connections.open,
  }

  function open() {
    if (!dialogs.navigate()) return
    if (!state.connected || !state.snapshot) return say("Connect to the server before choosing a model.", true)
    const session =
      state.tab === "sessions" ? state.snapshot.sessions.find((item) => item.id === state.selected) : undefined
    if (!session) return connections.open(state.snapshot.location.directory, () => {})
    if (blocked(session.id)) return say("Task-owned subagent: choose a model in its owning session.", true)
    pickForSession(ctx, session)
  }

  function connect(back?: () => void) {
    if (!dialogs.navigate()) return
    if (!state.connected || !state.snapshot) return say("Connect to the server before adding a provider.", true)
    const directory =
      state.snapshot.sessions.find((item) => item.id === state.selected)?.location.directory ??
      state.snapshot.location.directory
    connections.open(directory, back ?? open)
  }

  return { pick: (target: ModelTarget) => pick(ctx, target), open, connect }
}

export type Models = ReturnType<typeof createModels>
