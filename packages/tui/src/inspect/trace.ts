import { display } from "../messages"
import type { Panel } from "../panel"
import { array, identifier, numeric, object, string } from "../response-validation"
import { errorText, type Connection, type Session } from "../server"
import { label, type DashboardState } from "../state"

type TraceEvent = { id: string; type: string; seq: number; data: unknown }

const KEYS = "↑↓ event · [ older · ] newer · PgUp/PgDn read · Esc close"

/** One open Trace panel: the page of events shown and the cursors to its neighbours. */
export type TraceView = {
  state: DashboardState
  connection: Connection
  session: Session
  panel: Panel
  events: TraceEvent[]
  cursor: { previous?: string; next?: string }
}

export async function load(t: TraceView, page?: string) {
  const { panel } = t
  try {
    const result = await t.connection.client.sessions.replayHistory({
      sessionID: t.session.id,
      limit: 200,
      cursor: page,
    })
    if (t.state.modal !== panel.dialog) return
    t.events = array(result.data, 1000).map((value) => {
      const event = object(value)
      return {
        id: identifier(event.id),
        type: string(event.type, 256),
        seq: numeric(object(event.durable).seq),
        data: event.data,
      }
    })
    t.cursor = result.cursor
    panel.heading.content = `${t.events.length} events${t.events[0] ? ` · #${t.events[0].seq}–#${t.events.at(-1)!.seq}` : ""}`
    panel.list.options = t.events.map((event) => ({
      name: `#${event.seq} ${label(event.type, 60)}`,
      description: "",
    }))
    panel.dialog.error.content = KEYS
    describe(t)
  } catch (error) {
    if (t.state.modal === panel.dialog) panel.show(`Trace unavailable: ${errorText(error)}`)
  }
}

export function describe(t: TraceView) {
  const event = t.events[t.panel.list.getSelectedIndex()]
  t.panel.show(
    event ? `${event.type}\n${event.id}\n\n${display(JSON.stringify(event.data, null, 2) ?? "", 64000)}` : "No events.",
  )
}

/** `[` and `]` page through the log; any other key is left to the panel. */
export function pageKey(t: TraceView, sequence: string) {
  if (sequence !== "[" && sequence !== "]") return false
  const page = sequence === "[" ? t.cursor.previous : t.cursor.next
  if (page) void load(t, page)
  else t.panel.dialog.error.content = `No ${sequence === "[" ? "older" : "newer"} events.\n${KEYS}`
  return true
}
