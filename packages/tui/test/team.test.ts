import { expect, test } from "bun:test"
import { validateResponse } from "../src/response-validation"
import { mount, until, type Route } from "./support"

const room = { id: "trm_team", name: "team", topic: "Ship it", head: 3 }
const old = { id: "trm_old", name: "retro", topic: "", head: 1, archived: true }
const teammate = (handle: string, name: string, status = "active", created = 1) => ({
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
const mates = [teammate("moss", "Morgan"), teammate("rae", "Rachel", "paused", 2)]
const message = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${seq}`,
  roomID: "trm_team",
  seq,
  kind: "human",
  author: "You",
  text,
  time: Date.UTC(2026, 9, 8, 9, seq),
  ...extra,
})
const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "job_1",
  roomID: "trm_team",
  messageID: "msg_2",
  teammateID: "tm_moss",
  sessionID: "ses_main",
  status,
  time: { created: 2, updated: 2 },
  ...extra,
})

function answer(messages: unknown[], extra: Record<string, unknown> = {}) {
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

const log = [
  message(1, "Welcome"),
  message(2, "Please review @moss"),
  message(3, "Done", { kind: "teammate", author: "Morgan", teammateID: "tm_moss" }),
]

/** A Team server whose log grows when `more` has items; `calls` records every state query. */
function server(more: ReturnType<typeof message>[] = []) {
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

async function open(routes: Record<string, Route>, width = 120) {
  const app = await mount(width, routes)
  app.view.mockInput.pressKey("ESCAPE")
  await app.screen("f Reply")
  // A key right after Escape would read as Alt+key.
  await Bun.sleep(150)
  app.view.mockInput.pressKey("4")
  return app
}

test("the Team tab lists rooms and shows the latest messages of the selected room", async () => {
  const { routes } = server()
  const { screen } = await open(routes)
  const frame = await screen("Done")
  expect(frame).toContain("# team")
  expect(frame).not.toContain("retro")
  expect(frame).toContain("1 archived hidden")
  expect(frame).toMatch(/\d\d:\d\d You {2}Welcome/)
  expect(frame).toContain("→ @moss queued · session ses_main")
  expect(frame).toContain("@moss  Done")
  expect(frame).toContain("1 room")
})

test("polling asks after the highest loaded message and merges the answer", async () => {
  const { routes, calls } = server([message(4, "Fresh news")])
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("r")
  const frame = await screen("Fresh news")
  expect(frame).toContain("Done")
  expect(calls[0]!.has("after")).toBe(false)
  expect(calls.some((call) => call.get("after") === "3" && call.get("roomID") === "trm_team")).toBe(true)
})

test("a server without the Team route shows why, keeps the dashboard connected, and offers Sessions", async () => {
  const { view, screen } = await open({})
  const frame = await screen("Team unavailable")
  expect(frame).toContain("Press r to retry.")
  expect(frame).toContain("Sessions remain available")
  expect(frame).not.toContain("Disconnected")
  view.mockInput.pressKey("1")
  await screen("main says hello")
})

test("posting sends the draft ID, and a retry after a 503 sends the same ID", async () => {
  let attempts = 0
  const { routes } = server()
  const posted = message(4, "ship @moss now")
  const sent: { id: string; roomID: string; text: string }[] = []
  routes["POST /api/team/message"] = async (request) => {
    sent.push(await request.json())
    if (++attempts === 1) return new Response("down", { status: 503 })
    return { message: { ...posted, id: sent[0]!.id }, tasks: [task("queued", { messageID: sent[0]!.id })] }
  }
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention:")
  await view.mockInput.typeText("ship @moss now")
  await screen("Tasks for: @moss")
  view.mockInput.pressEnter()
  await screen("HTTP 503")
  view.mockInput.pressEnter()
  await screen("Posted. @moss got a task.")
  expect(sent).toHaveLength(2)
  expect(sent[0]!.id).toStartWith("msg_")
  expect(sent[1]).toEqual(sent[0]!)
  expect(sent[0]!.roomID).toBe("trm_team")
  await screen("ship @moss now")
})

test("a 400 keeps the draft editable with the server's message", async () => {
  const { routes } = server()
  const ids: string[] = []
  routes["POST /api/team/message"] = async (request) => {
    ids.push(((await request.json()) as { id: string }).id)
    return Response.json({ _tag: "InvalidRequestError", message: "Text is too spicy" }, { status: 400 })
  }
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("hello")
  view.mockInput.pressEnter()
  await screen("Text is too spicy")
  await view.mockInput.typeText("!")
  await screen("hello!")
  view.mockInput.pressEnter()
  await until(() => ids.length === 2)
  expect(ids[1]).toBe(ids[0]!)
})

test("typing @ lists the room's teammates and Tab inserts the handle with a space", async () => {
  const { routes } = server()
  const sent: { text: string }[] = []
  routes["POST /api/team/message"] = async (request) => {
    sent.push(await request.json())
    return Response.json({ _tag: "InvalidRequestError", message: "stop here" }, { status: 400 })
  }
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention:")
  await view.mockInput.typeText("hi @mo")
  const list = await screen("Morgan · Engineer")
  expect(list).not.toContain("Rachel")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("go")
  view.mockInput.pressEnter()
  await until(() => sent.length === 1)
  expect(sent[0]!.text).toBe("hi @moss go")
})

test("a draft with no mention names the coordinator, and an unknown handle is flagged", async () => {
  const { routes } = server()
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention: @moss (coordinator) replies.")
  await view.mockInput.typeText("ask @zed ")
  await screen("@zed is not in this room")
})

test("archived rooms are hidden until A, and refuse posting", async () => {
  const { routes } = server()
  const { view, screen } = await open(routes)
  await screen("1 archived hidden")
  view.mockInput.pressKey("A", { shift: true })
  const frame = await screen("# retro · archived")
  expect(frame).toContain("Archived rooms shown")
  view.mockInput.pressArrow("up")
  const archived = await screen("Archived · read-only. Restore does not resume paused schedules.")
  expect(archived).toContain("# retro")
  view.mockInput.pressKey("f")
  await screen("Archived rooms are read-only.")
})

test("the tasks list opens the task's session in the Sessions tab", async () => {
  const { routes } = server()
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("t")
  const dialog = await screen("queued · @moss · Please review @moss")
  expect(dialog).toContain("Enter open session · c cancel task · r refresh")
  view.mockInput.pressEnter()
  await screen("main says hello")
})

test("a queued task is cancelled only after typing the confirmation word", async () => {
  const { routes } = server()
  let cancelled = 0
  routes["POST /api/team/task/job_1/cancel"] = () => {
    cancelled++
    return task("cancelled")
  }
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("t")
  await screen("Enter open session")
  view.mockInput.pressKey("c")
  await screen("Confirmation (type cancel)")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Type cancel to confirm.")
  expect(cancelled).toBe(0)
  await view.mockInput.typeText("cancel")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => cancelled === 1)
})

test("cancelling acts on the task highlighted when the list was drawn, not on a later poll's list", async () => {
  const { routes, calls } = server()
  let newer = false
  const base = routes["GET /api/team"]!
  routes["GET /api/team"] = async (request, url) => {
    const result = (await base(request, url)) as { tasks: unknown[] }
    return newer
      ? { ...result, tasks: [task("queued", { id: "job_9", time: { created: 9, updated: 9 } }), ...result.tasks] }
      : result
  }
  const cancelled: string[] = []
  routes["POST /api/team/task/job_1/cancel"] = () => (cancelled.push("job_1"), task("cancelled"))
  routes["POST /api/team/task/job_9/cancel"] = () => (cancelled.push("job_9"), task("cancelled", { id: "job_9" }))
  const { view, screen } = await open(routes)
  await screen("Done")
  view.mockInput.pressKey("t")
  await screen("Enter open session")
  const seen = calls.length
  newer = true
  await until(() => calls.length > seen)
  await Bun.sleep(150)
  view.mockInput.pressKey("c")
  const frame = await screen("Confirmation (type cancel)")
  expect(frame).toContain("@moss · queued · job_1")
  await view.mockInput.typeText("cancel")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => cancelled.length === 1)
  expect(cancelled).toEqual(["job_1"])
})

test("[ loads the page before the lowest loaded message and merges it above", async () => {
  const { routes, calls } = server()
  const base = routes["GET /api/team"]!
  routes["GET /api/team"] = async (request, url) => {
    if (url.searchParams.has("before")) {
      calls.push(url.searchParams)
      return answer([message(0, "Long ago")], { hasMore: false })
    }
    return { ...((await base(request, url)) as object), hasMore: true }
  }
  const { view, screen } = await open(routes)
  await screen("Earlier messages")
  view.mockInput.pressKey("[")
  await screen("Long ago")
  expect(calls.some((call) => call.get("before") === "1")).toBe(true)
})

test("a narrow footer names the Team view", async () => {
  const { routes } = server()
  const { screen } = await open(routes, 80)
  await screen("View 4/4 Team")
})

const valid = () => answer(log)
const check = (value: unknown) => validateResponse(new URL("http://x/api/team"), undefined, value)

test("the Team validator accepts a valid state and rejects malformed ones", () => {
  expect(check(valid())).toBeDefined()
  expect(() => check({ ...valid(), room: { ...room, id: "bad id" } })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), room: old, rooms: [room] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), messages: Array.from({ length: 201 }, (_, i) => message(i + 1, "x")) })).toThrow(
    "exceeds",
  )
  expect(() => check({ ...valid(), messages: [{ ...log[0], time: "Infinity" }] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), tasks: [task("queued", { sessionID: "../x" })] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), teammates: [{ ...mates[0], handle: "bad handle" }] })).toThrow(
    "Invalid server response",
  )
  expect(() => check({ ...valid(), messages: [log[0], log[0]] })).toThrow("duplicate")
})
