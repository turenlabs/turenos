import { turen, type Route } from "./support"

export const room = { id: "trm_team", name: "Team", topic: "Ship it", head: 2 }

const retro = { id: "trm_retro", name: "retro", topic: "", head: 1, archived: true }

const factoryRoom = {
  id: "trm_fact",
  name: "Factory",
  topic: "",
  head: 0,
  factory: {
    revision: 3,
    config: {
      outcome: "Ship the report",
      parameters: {},
      constraints: "",
      acceptanceCriteria: "Reviewed",
      directory: "/srv/main",
      coordinatorTeammateID: "tm_moss",
      teammateIDs: ["tm_moss"],
    },
  },
}

export const teammate = (handle: string, status = "active", created = 1, roomID = "trm_team") => ({
  id: `tm_${handle}`,
  roomID,
  name: handle.toUpperCase(),
  handle,
  role: "Engineer",
  mission: "",
  status,
  directory: "/srv/main",
  time: { created, updated: created },
})

export const message = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${seq}`,
  roomID: "trm_team",
  seq,
  kind: "human",
  author: "You",
  text,
  time: Date.UTC(2026, 9, 8, 9, seq),
  ...extra,
})

export const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "job_1",
  roomID: "trm_team",
  messageID: "msg_2",
  teammateID: "tm_moss",
  sessionID: "ses_work",
  status,
  time: { created: 2, updated: 2 },
  ...extra,
})

export const factoryRun = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "run-1",
  roomID: "trm_fact",
  status,
  phase: status === "running" ? "work" : "done",
  taskIDs: ["job_f"],
  time: { created: 5, updated: 6 },
  ...extra,
})

const rooms = [room, retro, factoryRoom]

/** What the state route answers for a room, by ID; the default room is `trm_team`. */
export function state(roomID: string | null, limit = 100) {
  const current = rooms.find((item) => item.id === (roomID ?? "trm_team"))!
  const mates = current.id === "trm_team" ? [teammate("moss"), teammate("rae", "paused", 2)] : []
  const messages = current.id === "trm_team" ? [message(1, "Welcome"), message(2, "Review @moss\nplease")] : []
  return {
    rooms,
    room: current,
    teammates: current.id === "trm_fact" ? [teammate("moss", "active", 1, "trm_fact")] : mates,
    messages: messages.slice(-limit),
    tasks: current.id === "trm_team" ? [task("running"), task("succeeded", { id: "job_0" })] : [],
    duties: [],
    factoryRuns: current.id === "trm_fact" ? [factoryRun("succeeded", { result: "All good\nnext line" })] : [],
    hasMore: false,
  }
}

export const stateRoute: Route = (_, url) =>
  state(url.searchParams.get("roomID"), Number(url.searchParams.get("limit") ?? 100))

export function team(routes: Record<string, Route> = {}) {
  return turen({ routes: { "GET /api/team": stateRoute, ...routes } })
}
