import { newMessages, waitingOnYou } from "./attention"
import { plural } from "./format"
import { label, type DashboardState, type Row } from "../state"
import { viewOf, visibleRooms } from "./types"

/**
 * Sidebar rows: one per room. The list draws only the name line, so the marks (waiting, new, working) follow the name
 * there, most urgent first because a narrow sidebar cuts the end. The description feeds the filter: only the loaded
 * room's teammates are known, so the others show their message count.
 */
export function roomRows(state: DashboardState): Row[] {
  const view = viewOf(state)
  const waiting = waitingOnYou(view, state.snapshot?.needsInput)
  return visibleRooms(view).map((room) => {
    const unread = newMessages(view, room)
    const marks = [
      view.room?.id === room.id && waiting ? `${waiting} waiting` : "",
      unread ? `${unread} new` : "",
      view.activeRoomIDs.includes(room.id) ? "working" : "",
    ].filter(Boolean)
    return {
      id: room.id,
      name: [`# ${label(room.name, marks.length ? 14 : 100)}${room.archived ? " · archived" : ""}`, ...marks].join(
        " · ",
      ),
      description: room.topic
        ? label(room.topic, 250)
        : view.room?.id === room.id
          ? plural(view.teammates.length, "teammate")
          : plural(room.head, "message"),
    }
  })
}

/** The sidebar note above the list. */
export function roomNote(state: DashboardState) {
  const view = viewOf(state)
  if (view.error) return "Team unavailable. r retries."
  const hidden = view.rooms.length - visibleRooms(view).length
  if (hidden) return `${hidden} archived hidden · A shows`
  if (!view.rooms.length) return view.room ? "No rooms." : "Loading rooms…"
  return view.showArchived ? "Archived rooms shown · A hides" : ""
}
