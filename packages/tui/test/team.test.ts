import { expect, test } from "bun:test"
import { promptBoxText } from "../src/chrome"
import { createDashboardState } from "../src/state"
import { roomLog } from "../src/team/format"
import type { TeamView } from "../src/team/types"
import { until } from "./support"
import { answer, message, old, open, room, server, task } from "./team-fixture"

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
  expect(frame).toContain("no Team rooms")
  expect(frame).toContain("1.0.43")
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
  await screen("4/4 Team")
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
  expect(text).toContain("full output in session …es_other")
})

test("a reply names what it answers beside the author, from loaded messages only", () => {
  const reply = { kind: "teammate", author: "Morgan", teammateID: "tm_moss" }
  const view = {
    ...answer([
      message(2, "Check\n  the result"),
      message(3, "Done", { ...reply, replyTo: "msg_2" }),
      message(4, "About that", { ...reply, replyTo: "msg_1" }),
      message(5, "Noted", { ...reply, replyTo: "msg_3" }),
      message(6, "\u001b]0;title\u0007Hi"),
      message(7, "Hello", { ...reply, replyTo: "msg_6" }),
    ]),
    showArchived: false,
    pendingRuns: new Map(),
  } as unknown as TeamView
  const text = roomLog(view)
  expect(text).toContain("@moss  ↳ reply to You: Check the result\n      Done")
  expect(text).toContain("@moss  ↳ reply to a message not loaded\n      About that")
  expect(text).toContain("@moss  ↳ reply to @moss: Done\n      Noted")
  expect(text).not.toContain("\u001b")
  expect(text).not.toContain("\u0007")
})

test("the post row names posting and nothing else", () => {
  const state = createDashboardState()
  state.connected = true
  state.tab = "team"
  state.selected = room.id
  state.team = { room } as unknown as TeamView
  expect(promptBoxText(state, undefined, { hasDraft: false })).toBe("f Post")
  state.team = { room: old } as unknown as TeamView
  expect(promptBoxText(state, undefined, { hasDraft: false })).toStartWith("Archived · read-only")
})

test("a mention nobody in the room answers to says nobody is tasked, and the status says why after posting", async () => {
  const { routes } = server()
  routes["POST /api/team/message"] = async (request) => {
    const body = (await request.json()) as { id: string; text: string }
    return { message: { ...message(4, body.text), id: body.id }, tasks: [] }
  }
  const { view, screen } = await open(routes, 160)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention:")
  await view.mockInput.typeText("@zed please check")
  await screen("@zed is not in this room: nobody is tasked. Remove it, or press @ to pick a teammate.")
  view.mockInput.pressEnter()
  await screen("Posted. No task: @zed is not in this room.")
})

test("a paused teammate is not offered a task, and the status says so after posting", async () => {
  const { routes } = server()
  routes["POST /api/team/message"] = async (request) => {
    const body = (await request.json()) as { id: string; text: string }
    return { message: { ...message(4, body.text), id: body.id }, tasks: [] }
  }
  const { view, screen } = await open(routes, 140)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention:")
  await view.mockInput.typeText("hello @rae now")
  const frame = await screen("@rae is paused: no task. M, then Enter on @rae, then Resume.")
  expect(frame).not.toContain("Tasks for: @rae")
  view.mockInput.pressEnter()
  await screen("Posted. No task: @rae is paused.")
})

test("the log prints a coordinator's plan and verdict as one line, shortens run IDs and closes a settled run", () => {
  const runID = "run_20261008_abcdef0123456789"
  const plan = JSON.stringify({
    assignments: [
      { teammateID: "tm_rae", prompt: "Reply with the word ready and nothing else" },
      { teammateID: "tm_moss", prompt: "Summarise the notes" },
    ],
  })
  const reply = { kind: "teammate", teammateID: "tm_rae", author: "Rachel" }
  const view = {
    ...answer([
      message(1, `Factory run ${runID} planning task`, { kind: "system", author: "Factory" }),
      message(2, plan, { ...reply, sourceMessageIDs: ["msg_1"] }),
      message(3, `Factory run ${runID} result check`, { kind: "system", author: "Factory" }),
      message(4, '{"status":"accepted","summary":"Both teammates answered."}', { ...reply, sourceMessageIDs: ["msg_3"] }),
      message(5, "Thanks all"),
    ]),
    factoryRuns: [
      {
        id: runID,
        roomID: "trm_team",
        status: "succeeded",
        phase: "done",
        taskIDs: ["job_1", "job_2"],
        time: { created: 1, updated: Date.UTC(2026, 9, 8, 9, 30) },
      },
    ],
    tasks: [task("succeeded", { id: "job_1", messageID: "msg_1" }), task("succeeded", { id: "job_2", messageID: "msg_3" })],
    showArchived: false,
    pendingRuns: new Map(),
  } as unknown as TeamView
  const lines = roomLog(view).split("\n")
  const text = lines.join("\n")
  expect(text).toContain('Factory run …23456789 planning task')
  expect(text).not.toContain(runID)
  expect(text).toContain('plan: @rae "Reply with the word ready and n…", @moss "Summarise the notes"')
  expect(text).toContain("check: accepted — Both teammates answered.")
  const closing = lines.findIndex((line) => line.endsWith("· Factory run …23456789 succeeded"))
  expect(closing).toBeGreaterThan(lines.findIndex((line) => line.includes("check: accepted")))
  expect(closing).toBeLessThan(lines.findIndex((line) => line.includes("Thanks all")))
})

test("a room with no teammates says how to add one, and the action row leads with it", async () => {
  const { routes } = server()
  routes["GET /api/team"] = () => answer([message(1, "Welcome")], { teammates: [], tasks: [] })
  const { screen } = await open(routes, 170, 30)
  const frame = await screen("No teammates yet. Press M, then a, to add one; teammates answer posts and take tasks.")
  expect(frame).toContain("M Add teammate")
  expect(frame).toContain("a New room")
  expect(frame).toContain("d Room")
})
