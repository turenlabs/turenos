import { array, choice, numeric, object, optional, string } from "./primitives"

export function roomRoute(route: string[], init: RequestInit | undefined, response: Record<string, unknown>) {
  const data = object(response.data)
  if (route[3] !== "entries") return roomOverview(data)
  const entries = init?.method === "POST" ? [data] : array(data.entries, 1000)
  if (init?.method !== "POST") numeric(data.head)
  for (const value of entries) {
    const entry = object(value)
    numeric(entry.seq)
    numeric(entry.timeCreated)
    string(entry.kind, 32)
    string(entry.text)
    string(object(entry.actor).name, 512)
    choice(object(entry.actor).type, ["leader", "worker", "human", "system"])
  }
}

function roomOverview(data: Record<string, unknown>) {
  const room = object(data.room)
  string(room.objective, 64000)
  choice(room.status, ["open", "closed"])
  for (const value of array(data.members, 512)) {
    string(object(value).name, 512)
    choice(object(value).state, ["active", "parked", "settled", "blocked", "left"])
  }
  for (const value of array(data.lanes, 256)) {
    const lane = object(value)
    string(lane.title, 4096)
    choice(lane.status, ["open", "claimed", "done", "blocked"])
    optional(lane.claimedByName, (name) => string(name, 512))
  }
}
