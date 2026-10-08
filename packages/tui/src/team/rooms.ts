import { label, type DashboardState, type Row } from "../state"
import { viewOf, visibleRooms } from "./types"

/** Sidebar rows: one per room. Only the loaded room's teammates are known, so the others show their message count. */
export function roomRows(state: DashboardState): Row[] {
  const view = viewOf(state)
  return visibleRooms(view).map((room) => ({
    id: room.id,
    name: `# ${label(room.name, 100)}${room.archived ? " · archived" : ""}`,
    description: room.topic
      ? label(room.topic, 250)
      : view.room?.id === room.id
        ? `${view.teammates.length} teammates`
        : `${room.head} messages`,
  }))
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
