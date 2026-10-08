import { expect, test } from "bun:test"
import { promptBoxText } from "../src/chrome"
import { validateResponse } from "../src/response-validation"
import { createDashboardState } from "../src/state"
import { roomLog } from "../src/team/format"
import type { TeamView } from "../src/team/types"
import { until } from "./support"
import { answer, log, message, mates, old, open, room, server, task } from "./team-fixture"

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

test("a post into an empty room does not hide a message another client posted first", async () => {
  const stored: ReturnType<typeof message>[] = []
  const { routes } = server()
  routes["GET /api/team"] = (_, url) => {
    const after = Number(url.searchParams.get("after") ?? 0)
    return answer(stored.filter((item) => item.seq > after))
  }
  routes["POST /api/team/message"] = async (request) => {
    const sent = (await request.json()) as { id: string; text: string }
    // Another client's message took seq 1 before ours, and it is already stored when the answer returns.
    stored.push(message(1, "Posted by another client"), { ...message(2, sent.text), id: sent.id })
    return { message: stored[1], tasks: [] }
  }
  const { view, screen } = await open(routes)
  await screen("No messages yet.")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("hello from here")
  view.mockInput.pressEnter()
  await screen("Posted.")
  const frame = await screen("Posted by another client")
  expect(frame).toContain("hello from here")
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

const write = (path: string, method: string, value: unknown) =>
  validateResponse(new URL(`http://x/api/team${path}`), { method }, value)
const factory = {
  revision: 1,
  config: {
    outcome: "Ship",
    parameters: {},
    constraints: "",
    acceptanceCriteria: "Done",
    directory: "/srv/main",
    coordinatorTeammateID: "tm_moss",
    teammateIDs: ["tm_moss"],
  },
}
const finished = {
  id: "run_1",
  roomID: "trm_team",
  status: "succeeded",
  phase: "done",
  taskIDs: ["job_1"],
  result: "ok",
  time: { created: 1, updated: 2 },
}

type State = ReturnType<typeof valid>

test("a teammate role or name over 512 characters is clipped, not a reason to reject the room", () => {
  const long = "x".repeat(513)
  const state = check({ ...valid(), teammates: [{ ...mates[0], role: long, name: long }] }) as State
  expect(state.teammates[0]!.role).toContain("[truncated")
  expect(state.teammates[0]!.name).toContain("[truncated")
  expect(() => check({ ...valid(), teammates: [{ ...mates[0], name: "bad\u202ename" }] })).toThrow(
    "Invalid server response",
  )
})

test("a room with more than 200 teammates is readable, up to the collection bound", () => {
  const crowd = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...mates[0], id: `tm_${index}`, handle: `mate${index}` }))
  expect((check({ ...valid(), teammates: crowd(201) }) as State).teammates).toHaveLength(201)
  expect(() => check({ ...valid(), teammates: crowd(1001) })).toThrow("exceeds")
})

test("a message author and a task error over their display bounds are clipped", () => {
  const state = check({
    ...valid(),
    messages: [{ ...log[0], author: "x".repeat(513) }],
    tasks: [task("failed", { error: "e".repeat(8001) })],
  }) as State
  expect((state.messages[0] as { author: string }).author).toContain("[truncated")
  expect((state.tasks[0] as unknown as { error: string }).error).toContain("[truncated")
})

test("a posted message may create more than 256 tasks", () => {
  const tasks = Array.from({ length: 300 }, (_, index) => task("queued", { id: `job_${index}` }))
  expect(write("/message", "POST", { message: log[0], tasks })).toBeDefined()
})

test("the Team validator checks the answers of the write routes", () => {
  expect(write("/room", "POST", room)).toBeDefined()
  expect(write("/room/trm_team", "PATCH", room)).toBeDefined()
  expect(write("/room/trm_team/archive", "POST", { ...room, archived: true })).toBeDefined()
  expect(write("/room/trm_team/factory", "PUT", { ...room, factory })).toBeDefined()
  expect(() => write("/room/trm_old", "PATCH", room)).toThrow("room identity")
  expect(() => write("/room", "POST", { ...room, id: "bad id" })).toThrow("Invalid server response")
  expect(() => write("/room/trm_team/factory", "PUT", { ...room, factory: { revision: 1, config: {} } })).toThrow(
    "Invalid server response",
  )
  expect(() => write("/room/trm_team/factory", "PUT", { ...room, factory: { ...factory, revision: -1 } })).toThrow(
    "Invalid server response",
  )
  expect(write("/teammate", "POST", mates[0])).toBeDefined()
  expect(
    write("/teammate/tm_moss", "PATCH", {
      ...mates[0],
      id: "tm_moss",
      agent: "plan",
      model: { providerID: "p", id: "m" },
    }),
  ).toBeDefined()
  expect(() => write("/teammate/tm_other", "PATCH", mates[0])).toThrow("teammate identity")
  expect(() => write("/teammate", "POST", { ...mates[0], handle: "bad handle" })).toThrow("Invalid server response")
  expect(() => write("/teammate", "POST", { ...mates[0], directory: "relative" })).toThrow("Invalid server response")
  expect(() => write("/teammate", "POST", { ...mates[0], model: { providerID: "p" } })).toThrow(
    "Invalid server response",
  )
  expect(write("/teammate/tm_moss/duty", "POST", { loopID: "loop_1", teammateID: "tm_moss" })).toBeDefined()
  expect(() => write("/teammate/tm_moss/duty", "POST", { loopID: "loop_1", teammateID: "tm_rae" })).toThrow("identity")
  expect(write("/room/trm_team/factory/run", "POST", finished)).toBeDefined()
  expect(write("/factory-run/run_1", "GET", finished)).toBeDefined()
  expect(write("/factory-run/run_1/cancel", "POST", { ...finished, status: "cancelled" })).toBeDefined()
  expect(() => write("/factory-run/run_2", "GET", finished)).toThrow("Invalid server response")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, status: "weird" })).toThrow("Invalid server response")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, time: { created: "NaN", updated: 1 } })).toThrow(
    "Invalid server response",
  )
  expect(() => write("/factory-run/run_1", "GET", { ...finished, taskIDs: ["../x"] })).toThrow(
    "Invalid server response",
  )
})

test("a factory run's result is cut rather than rejected, and its error is bounded", () => {
  const long = write("/factory-run/run_1", "GET", { ...finished, result: "x".repeat(40_000) }) as { result: string }
  expect(long.result.length).toBeLessThan(33_000)
  expect(long.result).toContain("[truncated")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, error: "x".repeat(9000) })).toThrow(
    "Invalid server response",
  )
})

test("the state answer validates the factory runs and duties it carries", () => {
  expect(() => check({ ...valid(), factoryRuns: [{ ...finished, id: "bad id" }] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), factoryRuns: [finished, finished] })).toThrow("duplicate")
  expect(() => check({ ...valid(), duties: [{ loopID: "loop_1" }] })).toThrow("Invalid server response")
  expect(() =>
    check({
      ...valid(),
      room: { ...room, factory: { revision: 1, config: { ...factory.config, outcome: "x".repeat(4001) } } },
      rooms: [old, { ...room, factory: { revision: 1, config: { ...factory.config, outcome: "x".repeat(4001) } } }],
    }),
  ).toThrow("Invalid server response")
})

test("a teammate reply points at its session only when no task line already names it", () => {
  const reply = { kind: "teammate", author: "Morgan", teammateID: "tm_moss", sourceMessageIDs: ["msg_a"] }
  const view = {
    ...answer([
      message(2, "Please review @moss"),
      message(3, "Done", { ...reply, sessionID: "ses_main" }),
      message(4, "Also done", { ...reply, sessionID: "ses_other" }),
    ]),
    showArchived: false,
    pendingRuns: new Map(),
  } as unknown as TeamView
  const text = roomLog(view)
  expect(text).toContain("→ @moss queued · session ses_main")
  expect(text).not.toContain("full output in session ses_main")
  expect(text).toContain("full output in session ses_other")
})

test("the post row names posting and mentions rather than repeating the action row's keys", () => {
  const state = createDashboardState()
  state.connected = true
  state.tab = "team"
  state.selected = room.id
  state.team = { room } as unknown as TeamView
  expect(promptBoxText(state, undefined, { hasDraft: false })).toBe("f Post · @ mentions a teammate")
  state.team = { room: old } as unknown as TeamView
  expect(promptBoxText(state, undefined, { hasDraft: false })).toStartWith("Archived · read-only")
})
