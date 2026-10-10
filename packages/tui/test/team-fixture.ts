import { mount, type Route } from "./support"

export const room = { id: "trm_team", name: "team", topic: "Ship it", head: 3 }
export const old = { id: "trm_old", name: "retro", topic: "", head: 1, archived: true }
export const teammate = (handle: string, name: string, status = "active", created = 1) => ({
  id: `tm_${handle}`,
  roomID: "trm_team",
  name,
  handle,
  role: "Engineer",
  mission: "",
  status,
  directory: "/srv/main",
  time: { created, updated: created },
})
export const mates = [teammate("moss", "Morgan"), teammate("rae", "Rachel", "paused", 2)]
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
  sessionID: "ses_main",
  status,
  time: { created: 2, updated: 2 },
  ...extra,
})

export function answer(messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    rooms: [old, room],
    room,
    teammates: mates,
    messages,
    tasks: [task("queued")],
    duties: [],
    factoryRuns: [],
    hasMore: false,
    ...extra,
  }
}

export const log = [
  message(1, "Welcome"),
  message(2, "Please review @moss"),
  message(3, "Done", { kind: "teammate", author: "Morgan", teammateID: "tm_moss" }),
]

/** A Team server whose log grows when `more` has items; `calls` records every state query. */
export function server(more: ReturnType<typeof message>[] = []) {
  const calls: URLSearchParams[] = []
  const routes: Record<string, Route> = {
    "GET /api/team": (_, url) => {
      calls.push(url.searchParams)
      if (url.searchParams.get("roomID") === "trm_old")
        return answer([{ ...message(1, "Wrapped up"), roomID: "trm_old" }], { room: old, teammates: [], tasks: [] })
      const after = Number(url.searchParams.get("after") ?? 0)
      return answer(url.searchParams.has("after") ? [...log, ...more].filter((item) => item.seq > after) : log)
    },
  }
  return { calls, routes }
}

export async function open(routes: Record<string, Route>, width = 120, height = 24) {
  const app = await mount(width, routes, height)
  app.view.mockInput.pressKey("ESCAPE")
  await app.screen("h History")
  // A key right after Escape would read as Alt+key.
  await Bun.sleep(150)
  app.view.mockInput.pressKey("4")
  return app
}

export const loop = {
  id: "loop_1",
  name: "Nightly check",
  prompt: "Run the tests",
  location: { directory: "/srv/main" },
  status: "active",
  schedule: { type: "interval", seconds: 86400, timezone: "UTC" },
}

export type World = ReturnType<typeof world>

/**
 * A Team server whose answers follow what the tests change: `rooms`, `teammates`, `duties`, `runs` and `loops`.
 * Every request is recorded in `sent`, so a test proves exactly what the client wrote.
 */
export function world(routes: Record<string, Route> = {}) {
  const state = {
    rooms: [old, room] as Record<string, unknown>[],
    teammates: [...mates] as Record<string, unknown>[],
    tasks: [task("queued")] as Record<string, unknown>[],
    duties: [] as Record<string, unknown>[],
    runs: [] as Record<string, unknown>[],
    loops: [] as Record<string, unknown>[],
    sent: [] as { method: string; path: string; body: Record<string, unknown> }[],
  }
  const record =
    (route: Route): Route =>
    async (request, url) => {
      const text = await request.clone().text()
      state.sent.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : {} })
      return route(request, url)
    }
  const all: Record<string, Route> = {
    "GET /api/team": (_, url) => {
      const current = state.rooms.find((item) => item.id === (url.searchParams.get("roomID") ?? "trm_team"))!
      const here = current.id === "trm_team"
      return {
        rooms: state.rooms,
        room: current,
        teammates: here ? state.teammates : [],
        messages: here ? log : [],
        tasks: here ? state.tasks : [],
        duties: here ? state.duties : [],
        factoryRuns: here ? state.runs : [],
        hasMore: false,
      }
    },
    "GET /api/loop": () => state.loops,
  }
  for (const [key, route] of Object.entries(routes)) all[key] = key.startsWith("GET ") ? route : record(route)
  return {
    state,
    routes: all,
    sent: (method: string, path: string) => state.sent.filter((item) => item.method === method && item.path === path),
  }
}
