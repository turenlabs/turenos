import type { TeamOperations } from "./actions"
import { viewOf, type Room, type TeamContext } from "./types"

/** The loaded room the sidebar has selected, which the room actions work on; says why when there is none. */
export function loadedRoom(ctx: TeamContext) {
  const view = viewOf(ctx.state)
  if (ctx.state.tab !== "team" || !view.room || view.room.id !== ctx.state.selected)
    return void ctx.say("Select a room first.", true)
  return view.room
}

/** Writes actions refuse while the server is unreachable, before a dialog invites typing. */
export function online(ctx: TeamContext, what: string) {
  if (ctx.state.connected) return true
  ctx.say(`Reconnect before ${what}.`, true)
  return false
}

/** A room the server returned replaces its entry in the list and the loaded room. */
export function applyRoom(ctx: TeamContext, room: Room) {
  const view = viewOf(ctx.state)
  view.rooms = view.rooms.some((item) => item.id === room.id)
    ? view.rooms.map((item) => (item.id === room.id ? room : item))
    : [...view.rooms, room]
  if (view.room?.id === room.id) view.room = room
}

/**
 * Selects the next active room after `roomID` was archived or deleted, as the desktop does. With none left,
 * an archived room stays in view; a deleted one leaves the choice to the server's default room.
 */
export function leaveRoom(ctx: TeamContext, roomID: string, deleted: boolean) {
  const view = viewOf(ctx.state)
  if (deleted) view.rooms = view.rooms.filter((item) => item.id !== roomID)
  const next = view.rooms.find((item) => item.id !== roomID && !item.archived)
  if (next) ctx.state.selected = next.id
  else if (deleted) ctx.state.selected = ""
  else view.showArchived = true
  if (!deleted || view.room?.id !== roomID) return
  view.room = undefined
  view.messages = []
  view.tasks = []
  view.teammates = []
  view.duties = []
  view.factoryRuns = []
}

/** Reloads the room, then runs `next` unless the dashboard was closed or switched away meanwhile. */
export function reloaded(ctx: TeamContext, ops: TeamOperations, next: () => void) {
  void ops.sync().then(() => {
    if (!ctx.state.closed && ctx.state.tab === "team") next()
  })
}

/** Tells the user through the factory panel's hint lines, which stay visible where the footer is covered. */
export function panelNote(ctx: TeamContext, text: string) {
  viewOf(ctx.state).panelNote = text
  ctx.say(text)
  ctx.state.modal?.refresh?.()
}
