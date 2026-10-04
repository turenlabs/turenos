import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openPanel } from "./panel"
import { object } from "./response-validation"
import type { Connection } from "./server"
import { label, type DashboardState } from "./state"
import { openTools } from "./inspect/tools"
import { describe, load, pageKey, type TraceView } from "./inspect/trace"

/**
 * Two read-only looks inside a session, as in the desktop: Tools lists what its agent can call
 * right now (built-in, MCP, and excluded tools), and Trace pages through its durable event log.
 */
export function createInspect(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  function selected() {
    const session =
      state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
    if (!session) say("Select a session first.")
    return session
  }

  function tools() {
    const session = selected()
    if (!session || !dialogs.navigate()) return
    const model = session.model ?? lastModel(state, session.id)
    if (!model) return say("No model is known for this session yet. Send a message first, or choose one with m.")
    return openTools(
      renderer,
      dialogs,
      state,
      () =>
        connection
          .api("/experimental/tool", {
            directory: session.location.directory,
            query: { provider: model.providerID, model: model.id, sessionID: session.id },
          })
          .then(object),
      tools,
      session.model ? "" : " (server default)",
    )
  }

  function trace() {
    const session = selected()
    if (!session || !dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, `Trace · ${label(session.title || session.id, 60)}`)
    if (!panel) return
    const view: TraceView = { state, connection, session, panel, events: [], cursor: {} }
    panel.list.on("selectionChanged", () => describe(view))
    panel.dialog.key = (key) => pageKey(view, key.sequence)
    void load(view)
  }

  return { tools, trace }
}

/** A session on the server default model carries none; its latest reply says which one ran. */
function lastModel(state: DashboardState, sessionID: string) {
  if (state.detail?.sessionID !== sessionID) return undefined
  return state.detail.messages.findLast((message) => message.type === "assistant")?.model
}
