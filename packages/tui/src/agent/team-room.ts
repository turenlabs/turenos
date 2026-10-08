import { clean, emit, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { takes } from "./options"
import { idArgument } from "./state"
import { checked } from "../team/load"

/**
 * The Team state of a room the user named: its ID (`trm_…`), its exact name in any case, or the server's default room
 * when nothing is named. Past the room itself it carries the newest `limit` messages.
 */
export async function roomState(run: Run, given: string | undefined, limit: number) {
  const team = run.connection.client.team
  if (given === undefined) return checked(await team.state({ limit }))
  if (given.startsWith("trm_"))
    return checked(await team.state({ roomID: idArgument(given, "trm_", "The room"), limit }))
  const rooms = checked(await team.state({ limit: 1 })).rooms
  const named = rooms.filter((room) => room.name.toLowerCase() === given.trim().toLowerCase())
  // An archived room of the same name does not make an active one ambiguous.
  const matches = named.some((room) => !room.archived) ? named.filter((room) => !room.archived) : named
  if (matches.length > 1)
    throw usage(
      `More than one room is named "${clean(given, 80)}": ${matches.map((room) => room.id).join(", ")}. Use a room ID.`,
    )
  if (!matches[0])
    throw new AgentError(
      `No room named "${clean(given, 80)}" on this server. List them with: turen-tui team rooms --all${run.flags}`,
    )
  return checked(await team.state({ roomID: matches[0].id, limit }))
}

export async function rooms(run: Run) {
  takes("team rooms", run.positionals, [])
  // One request: the room list carries no teammates, and `team show` names them per room.
  const items = checked(await run.connection.client.team.state({ limit: 1 }))
    .rooms.filter((room) => run.values.all || !room.archived)
    .map((room) => ({ id: room.id, name: room.name, topic: room.topic, archived: !!room.archived }))
  return emit(
    run,
    { rooms: items },
    items.length
      ? items
          .map(
            (room) =>
              `room ${room.id} · ${clean(room.name, 120)}${room.archived ? " · archived" : ""}${room.topic ? ` · ${clean(room.topic, 200)}` : ""}`,
          )
          .join("\n")
      : "No rooms.",
  )
}
