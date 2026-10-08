import { array, choice, clip, identifier, invalid, numeric, object, optional, unique } from "./primitives"
import { duty, factoryRun, integer, room, teammate } from "./team-entities"
import { teamAnswer } from "./team-answers"

/** Collections the server does not bound (rooms, teammates, duties, and the tasks one message creates). */
const MAX_UNBOUNDED = 1000
const taskStatuses = ["queued", "claimed", "running", "succeeded", "failed", "cancelled", "stale"]

/**
 * The Team routes the TUI reads: the room state, a posted message and a cancelled task. Everything shown
 * is checked here; oversized message text is cut rather than rejected, so one long message cannot hide a room.
 */
export function team(route: string[], init: RequestInit | undefined, value: unknown) {
  const get = (init?.method ?? "GET") === "GET"
  if (route.length === 1 && get) return state(object(value))
  if (route.length === 2 && route[1] === "message" && init?.method === "POST") {
    const posted = object(value)
    message(object(posted.message))
    unique(array(posted.tasks, MAX_UNBOUNDED), (item) => task(object(item)))
    return posted
  }
  if (route.length === 4 && route[1] === "task" && route[3] === "cancel" && init?.method === "POST") {
    task(object(value))
    if (identifier(object(value).id) !== identifier(route[2])) invalid("task identity")
    return value
  }
  return teamAnswer(route, init, value)
}

function state(value: Record<string, unknown>) {
  const rooms = array(value.rooms, MAX_UNBOUNDED)
  unique(rooms, (item) => room(object(item)))
  const current = object(value.room)
  room(current)
  if (!rooms.some((item) => object(item).id === current.id)) invalid("room identity")
  const teammates = array(value.teammates, MAX_UNBOUNDED)
  unique(teammates, (item) => teammate(object(item), current.id))
  const messages = array(value.messages, 200)
  unique(messages, (item) => {
    message(object(item))
    if (object(item).roomID !== current.id) invalid("message identity")
  })
  unique(array(value.tasks, 256), (item) => {
    task(object(item))
    if (object(item).roomID !== current.id) invalid("task identity")
  })
  for (const item of array(value.duties, MAX_UNBOUNDED)) duty(object(item))
  optional(value.factoryRuns, (runs) => unique(array(runs, 50), (item) => factoryRun(object(item))))
  if (typeof value.hasMore !== "boolean") invalid("hasMore")
  return value
}

function message(item: Record<string, unknown>) {
  identifier(item.id)
  identifier(item.roomID, "trm_")
  integer(item.seq)
  choice(item.kind, ["human", "teammate", "system"])
  clip(item, "author", 512)
  clip(item, "text", 100_000)
  optional(item.teammateID, (id) => identifier(id))
  optional(item.sessionID, (id) => identifier(id, "ses_"))
  optional(item.sourceMessageIDs, (ids) => array(ids, 256).forEach((id) => identifier(id)))
  numeric(item.time)
}

function task(item: Record<string, unknown>) {
  identifier(item.id)
  identifier(item.roomID, "trm_")
  identifier(item.messageID)
  identifier(item.teammateID)
  // Enter on a task opens its session, so the identity is checked like every other session reference.
  identifier(item.sessionID, "ses_")
  choice(item.status, taskStatuses)
  optional(item.error, () => clip(item, "error", 8000))
  numeric(object(item.time).created)
}
