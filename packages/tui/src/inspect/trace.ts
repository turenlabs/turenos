import { fitHeading, panelWidth } from "../changes/heading"
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
  /** The latest page request; an older one that answers later must not paint over it. */
  request: number
}

/** The first load has no cursor and reads backwards from the end, so the panel opens on the newest events. */
export async function load(t: TraceView, page?: { cursor: string; direction: "before" | "after" }) {
  const { panel } = t
  const version = ++t.request
  try {
    const result = await t.connection.client.sessions.replayHistory({
      sessionID: t.session.id,
      limit: 200,
      cursor: page?.cursor,
      direction: page?.direction ?? "before",
    })
    if (version !== t.request || t.state.modal !== panel.dialog) return
    t.events = array(result.data, 1000).map((value) => {
      const event = object(value)
      return {
        id: identifier(event.id),
        type: string(event.type, 256),
        seq: numeric(object(event.durable).seq),
        data: event.data,
      }
    })
    t.cursor = neighbours(t.events, result.cursor, page)
    panel.heading.content = `${t.events.length} events${t.events[0] ? ` · #${t.events[0].seq}–#${t.events.at(-1)!.seq}` : ""}`
    panel.fit("rows", () => paintRows(t))
    panel.dialog.error.content = KEYS
    describe(t)
  } catch (error) {
    if (version === t.request && t.state.modal === panel.dialog) panel.show(`Trace unavailable: ${errorText(error)}`)
  }
}

/**
 * The server returns only the cursor that continues in the direction just read, so the other one is
 * the page's own edge event: the page was reached from there, which proves events lie beyond it.
 */
function neighbours(
  events: TraceEvent[],
  cursor: { previous?: string; next?: string },
  page: { direction: "before" | "after" } | undefined,
) {
  if (!page) return { previous: cursor.previous }
  if (page.direction === "before") return { previous: cursor.previous, next: events.at(-1)?.id }
  return { previous: events[0]?.id, next: cursor.next }
}

/** Event names fitted to the list column with an ellipsis, so a long name never ends mid-word unmarked. */
function paintRows(t: TraceView) {
  const width = Math.max(24, Math.floor(panelWidth(t.panel) * 0.34)) - 4
  const names = t.events.map((event) => fitHeading(width, `#${event.seq} `, label(event.type, 256), "", "end"))
  if (names.join("\n") === t.panel.list.options.map((option) => option.name).join("\n")) return
  t.panel.list.options = names.map((name) => ({ name, description: "" }))
}

export function describe(t: TraceView) {
  const event = t.events[t.panel.list.getSelectedIndex()]
  t.panel.show(
    event
      ? `${label(event.type, 256)}\n${event.id}\n\n${display(JSON.stringify(event.data, null, 2) ?? "", 64000)}`
      : "No events.",
  )
}

/** `[` and `]` page through the log; any other key is left to the panel. */
export function pageKey(t: TraceView, sequence: string) {
  if (sequence !== "[" && sequence !== "]") return false
  const cursor = sequence === "[" ? t.cursor.previous : t.cursor.next
  if (cursor) void load(t, { cursor, direction: sequence === "[" ? "before" : "after" })
  else t.panel.dialog.error.content = `No ${sequence === "[" ? "older" : "newer"} events.\n${KEYS}`
  return true
}
