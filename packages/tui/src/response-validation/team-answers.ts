import { identifier, invalid, object } from "./primitives"
import { duty, factoryRun, room, teammate } from "./team-entities"

/**
 * The answers of the Team write routes: a room, a teammate, a duty or a factory run, checked like the
 * entries of the state answer. A route that names its item must get that item back.
 */
export function teamAnswer(route: string[], init: RequestInit | undefined, value: unknown) {
  const method = init?.method ?? "GET"
  const [, kind, id, action] = route
  if (method === "DELETE" || (method === "POST" && action === "stop")) return undefined
  const item = object(value)
  if (kind === "room" && route.length === 5) {
    factoryRun(item)
    if (item.roomID !== id) invalid("room identity")
    return value
  }
  if (kind === "room" && route.length <= 4) {
    room(item)
    if (id !== undefined && item.id !== id) invalid("room identity")
    return value
  }
  if (kind === "teammate" && route.length === 4 && action === "duty") {
    duty(item)
    if (item.teammateID !== id) invalid("teammate identity")
    return value
  }
  if (kind === "teammate" && route.length <= 3) {
    teammate(item)
    if (id !== undefined && item.id !== id) invalid("teammate identity")
    return value
  }
  if (kind === "factory-run" && (route.length === 3 || action === "cancel")) {
    factoryRun(item)
    if (identifier(item.id) !== identifier(id)) invalid("factory run identity")
    return value
  }
  return undefined
}
