import { array, choice, clip, identifier, invalid, numeric, object, optional, string, unique } from "./primitives"

const taskStatuses = ["queued", "claimed", "running", "succeeded", "failed", "cancelled", "stale"]
const handle = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/

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
    unique(array(posted.tasks, 256), (item) => task(object(item)))
    return posted
  }
  if (route.length === 4 && route[1] === "task" && route[3] === "cancel" && init?.method === "POST") {
    task(object(value))
    if (identifier(object(value).id) !== identifier(route[2])) invalid("task identity")
    return value
  }
  return undefined
}

function state(value: Record<string, unknown>) {
  const rooms = array(value.rooms, 1000)
  unique(rooms, (item) => room(object(item)))
  const current = object(value.room)
  room(current)
  if (!rooms.some((item) => object(item).id === current.id)) invalid("room identity")
  const teammates = array(value.teammates, 200)
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
  for (const duty of array(value.duties, 1000)) {
    identifier(object(duty).loopID)
    identifier(object(duty).teammateID)
  }
  optional(value.factoryRuns, (runs) =>
    unique(array(runs, 50), (item) => {
      const run = object(item)
      identifier(run.roomID)
      choice(run.status, ["running", "succeeded", "needs_input", "failed", "cancelled", "stale"])
      choice(run.phase, ["plan", "work", "check", "done"])
      for (const id of array(run.taskIDs, 256)) identifier(id)
    }),
  )
  if (typeof value.hasMore !== "boolean") invalid("hasMore")
  return value
}

function room(item: Record<string, unknown>) {
  identifier(item.id, "trm_")
  string(item.name, 512)
  string(item.topic, 4096)
  integer(item.head)
  optional(item.archived, (flag) => typeof flag === "boolean" || invalid("archived"))
  optional(item.factory, (value) => {
    const config = object(object(value).config)
    string(config.coordinatorTeammateID, 256)
    for (const id of array(config.teammateIDs, 10)) string(id, 256)
  })
}

function teammate(item: Record<string, unknown>, roomID: unknown) {
  identifier(item.id)
  if (item.roomID !== roomID) invalid("teammate identity")
  string(item.name, 512)
  if (typeof item.handle !== "string" || !handle.test(item.handle)) invalid("handle")
  string(item.role, 512)
  choice(item.status, ["active", "paused"])
  // The coordinator rule orders by creation time.
  numeric(object(item.time).created)
}

function message(item: Record<string, unknown>) {
  identifier(item.id)
  identifier(item.roomID, "trm_")
  integer(item.seq)
  choice(item.kind, ["human", "teammate", "system"])
  string(item.author, 512)
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
  optional(item.error, (text) => string(text, 8000))
  numeric(object(item.time).created)
}

function integer(value: unknown) {
  if (!Number.isSafeInteger(numeric(value)) || (value as number) < 0) invalid("number")
}
