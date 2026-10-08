import { label } from "../state"
import type { Conversation } from "../conversation/context"
import { atBottom, commitPrepend } from "../conversation/position"
import { roomContext, roomLog } from "./format"
import { viewOf } from "./types"

/** What was last painted per conversation, to tell older messages arriving above from news below. */
const painted = new WeakMap<Conversation, { room: string; first: string | undefined }>()

/** Paints the Team tab's detail pane: the selected room's log, or why there is none. */
export function showRoom(c: Conversation, id: string) {
  const { state, ui } = c
  const view = viewOf(state)
  state.detail = undefined
  ui.sessionTitle.content = "Team"
  ui.context.visible = false
  if (view.error)
    return ui.renderContent(
      `Team unavailable: ${view.error.replace(/\.$/, "")}. Press r to retry. Sessions remain available: press 1.`,
    )
  if (!view.room)
    return ui.renderContent(view.rooms.length ? "Select a room." : "Loading Team rooms…\n\nPress r to retry.")
  if (!id || view.room.id !== id) {
    ui.sessionTitle.content = `# ${label(view.rooms.find((room) => room.id === id)?.name ?? "room", 150)}`
    return ui.renderContent("Loading room…")
  }
  ui.sessionTitle.content = `# ${label(view.room.name, 150)}`
  ui.context.content = roomContext(view)
  ui.context.visible = true
  paint(c, id, roomLog(view))
}

function paint(c: Conversation, room: string, text: string) {
  const { state, ui } = c
  const view = viewOf(state)
  const last = painted.get(c)
  const first = view.messages[0]?.id
  commitPrepend(c)
  const follow =
    view.follow || last?.room !== room || c.position?.scroll === Number.MAX_SAFE_INTEGER || (!c.position && atBottom(c))
  view.follow = false
  if (follow) c.position = { sessionID: room, history: false, scroll: Number.MAX_SAFE_INTEGER }
  else if (last.first !== first) {
    // Messages arrived above the reader (older ones loaded): keep the same line in view.
    c.prepend = { height: ui.detail.scrollHeight, scroll: ui.detail.scrollTop }
    c.position = { sessionID: room, history: false, scroll: ui.detail.scrollTop }
  }
  painted.set(c, { room, first })
  ui.renderContent(text)
  if (follow) ui.detail.scrollTo(Number.MAX_SAFE_INTEGER)
}
