import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { display } from "./messages"
import { openPanel } from "./panel"
import { openSection } from "./picker"
import { array, identifier, numeric, object, string } from "./response-validation"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"

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
    if (!session.model) return say("This session has no model yet; the tools depend on it. m chooses one.")
    const model = session.model
    return openSection(
      renderer,
      dialogs,
      state,
      { title: "Tools" },
      () =>
        connection
          .api("/experimental/tool", {
            directory: session.location.directory,
            query: { provider: model.providerID, model: model.id, sessionID: session.id },
          })
          .then(object),
      (snapshot, picker) => {
        picker.text.content = toolText(snapshot)
        picker.set([{ name: "Refresh", run: tools }])
      },
    )
  }

  function trace() {
    const session = selected()
    if (!session || !dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, `Trace · ${label(session.title || session.id, 60)}`)
    if (!panel) return
    let events: { id: string; type: string; seq: number; data: unknown }[] = []
    let cursor: { previous?: string; next?: string } = {}
    const keys = "↑↓ event · [ older · ] newer · PgUp/PgDn read · Esc close"

    async function load(page?: string) {
      try {
        const result = await connection.client.sessions.replayHistory({
          sessionID: session!.id,
          limit: 200,
          cursor: page,
        })
        if (state.modal !== panel!.dialog) return
        events = array(result.data, 1000).map((value) => {
          const event = object(value)
          return {
            id: identifier(event.id),
            type: string(event.type, 256),
            seq: numeric(object(event.durable).seq),
            data: event.data,
          }
        })
        cursor = result.cursor
        panel!.heading.content = `${events.length} events${events[0] ? ` · #${events[0].seq}–#${events.at(-1)!.seq}` : ""}`
        panel!.list.options = events.map((event) => ({
          name: `#${event.seq} ${label(event.type, 60)}`,
          description: "",
        }))
        panel!.dialog.error.content = keys
        describe()
      } catch (error) {
        if (state.modal === panel!.dialog) panel!.show(`Trace unavailable: ${errorText(error)}`)
      }
    }

    function describe() {
      const event = events[panel!.list.getSelectedIndex()]
      panel!.show(
        event
          ? `${event.type}\n${event.id}\n\n${display(JSON.stringify(event.data, null, 2) ?? "", 64000)}`
          : "No events.",
      )
    }

    panel.list.on("selectionChanged", describe)
    panel.dialog.key = (key) => {
      if (key.sequence !== "[" && key.sequence !== "]") return false
      const page = key.sequence === "[" ? cursor.previous : cursor.next
      if (page) void load(page)
      else panel.dialog.error.content = `No ${key.sequence === "[" ? "older" : "newer"} events.\n${keys}`
      return true
    }
    void load()
  }

  return { tools, trace }
}

function toolText(snapshot: Record<string, unknown>) {
  const visible = array(snapshot.visible, 2000).map((value) => {
    const tool = object(value)
    return `  ${label(string(tool.id, 256), 40)} · ${string(tool.source, 32)} — ${label(typeof tool.description === "string" ? tool.description : "", 120)}`
  })
  const servers = array(snapshot.mcpServers, 256).map((value) => {
    const server = object(value)
    return `  ${label(string(server.id, 256), 40)} · ${string(server.status, 32)}${typeof server.detail === "string" ? ` — ${label(server.detail, 160)}` : ""}`
  })
  const excluded = array(snapshot.exclusions, 2000).map((value) => {
    const item = object(value)
    const name = [item.id, item.server].find((part) => typeof part === "string") as string | undefined
    return `  ${label(name ?? "tool", 40)} — ${label(string(item.reason, 256), 80)}${typeof item.detail === "string" ? ` (${label(item.detail, 120)})` : ""}`
  })
  return [
    `Agent ${label(typeof snapshot.agent === "string" ? snapshot.agent : "default", 60)} · ${label(typeof snapshot.providerID === "string" ? snapshot.providerID : "", 60)}/${label(typeof snapshot.modelID === "string" ? snapshot.modelID : "", 80)}`,
    "",
    `TOOLS (${visible.length})`,
    ...visible,
    "",
    `MCP SERVERS (${servers.length})`,
    ...(servers.length ? servers : ["  None configured."]),
    "",
    `EXCLUDED (${excluded.length})`,
    ...(excluded.length ? excluded : ["  None."]),
  ].join("\n")
}
