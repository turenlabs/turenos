import { expect, test } from "bun:test"
import { dashboard, session } from "./support"

const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }
const accepted = async (request: Request) => ({ data: { id: (await request.json()).id, sessionID: "ses_main" } })
const queued = (id: string) => ({
  admittedSeq: 1,
  id,
  sessionID: "ses_main",
  prompt: { text: id },
  delivery: "queue",
  timeCreated: 1,
})

/** An active goal whose revision moves on its own, as it does while the agent works. */
function goalServer() {
  const remote = { revision: 3, status: "active", objective: "Ship it" }
  const goal = () => ({
    id: "goal_one",
    sessionID: "ses_main",
    revision: remote.revision,
    objective: remote.objective,
    status: remote.status,
    tokensUsed: 1,
    timeUsedSeconds: 1,
    time: { created: 1, updated: 2, statusChanged: 1 },
  })
  const routes = {
    "GET /api/session/ses_main/goal": () => ({ data: goal() }),
    "POST /api/session/ses_main/goal/status": async (request: Request) => {
      const body = (await request.json()) as { expectedRevision: number; status: string }
      if (body.expectedRevision !== remote.revision)
        return Response.json({ name: "SessionGoalConflictError", message: "revision conflict" }, { status: 409 })
      remote.status = body.status
      remote.revision++
      return { data: goal() }
    },
  }
  return { remote, routes }
}

test("going back from a goal confirmation keeps the objective that was typed", async () => {
  const { view, screen, palette } = await dashboard({ "GET /api/session/ses_main/goal": () => ({ data: null }) })
  await screen("main task")
  await palette("Session goal")
  await screen("No goal.")
  view.mockInput.pressEnter()
  await screen("Goal › Set?")
  await view.mockInput.typeText("ship the thing")
  view.mockInput.pressEscape()
  await screen("No goal.")
  view.mockInput.pressEnter()
  const frame = await screen("Goal › Set?")
  expect(frame).toContain("ship the thing")
})

test("pausing a goal whose revision moved on re-reads it and keeps the revision guard", async () => {
  const { remote, routes } = goalServer()
  const { server, view, screen, palette } = await dashboard(routes)
  await screen("main task")
  await palette("Session goal")
  await screen("Revision: 3")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Goal › Pause?")
  remote.revision = 9
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await screen("Goal paused.")
  expect(frame).not.toContain("acknowledged")
  expect(frame).not.toContain("revision changed")
  expect(server.sent("/api/session/ses_main/goal/status").at(-1)?.body).toMatchObject({
    expectedRevision: 9,
    status: "paused",
  })
})

test("a goal that was set says so plainly", async () => {
  let goal: unknown = null
  const { view, screen, palette } = await dashboard({
    "GET /api/session/ses_main/goal": () => ({ data: goal }),
    "PUT /api/session/ses_main/goal": async (request) => {
      const body = (await request.json()) as { id: string; objective: string }
      goal = {
        id: body.id,
        sessionID: "ses_main",
        revision: 1,
        objective: body.objective,
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 1, updated: 2, statusChanged: 1 },
      }
      return { data: goal }
    },
  })
  await screen("main task")
  await palette("Session goal")
  await screen("No goal.")
  view.mockInput.pressEnter()
  await screen("Goal › Set?")
  await view.mockInput.typeText("ship it")
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await screen("Goal set.")
  expect(frame).not.toContain("acknowledged")
  expect(frame).not.toContain("Active work stopped")
})

test("clearing a goal asks for a labelled word and no longer says a paused goal stops work", async () => {
  const { remote, routes } = goalServer()
  remote.status = "paused"
  const { view, screen, palette, confirm } = await dashboard({
    ...routes,
    "DELETE /api/session/ses_main/goal": () => new Response(null, { status: 204 }),
  })
  await screen("main task")
  await palette("Session goal")
  await screen("Revision: 3")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const frame = await screen("Confirmation (type clear)")
  expect(frame).not.toContain("STOPS active work")
  await confirm("cle")
  const failed = await screen("Type clear to confirm.")
  expect(failed).toContain("Ctrl+S clear")
})

test("the harness confirmation shows its whole warning", async () => {
  const snapshot = {
    version: 1,
    status: "active",
    source: "default",
    changes: [],
    validation: { status: "passed", errors: [], warnings: [] },
    tools: [],
    guidance: [],
    timestamps: { created: 1, updated: 1 },
  }
  const { view, screen, palette } = await dashboard({
    "GET /api/session/ses_main/harness": () => ({
      data: { snapshot, proposals: [], reviewerRequests: [], reviewerRuns: [] },
    }),
  })
  await screen("main task")
  await palette("Session harness")
  await screen("Reload harness")
  view.mockInput.pressEnter()
  const frame = await screen("Harness › Reload harness")
  expect(frame).toContain("next turn.")
  expect(frame).toContain("Esc back")
})

test("a reply sent to a running agent says whether it was queued or steered", async () => {
  const { view, screen } = await dashboard({ ...running, "POST /api/session/ses_main/prompt": accepted })
  await screen("u")
  view.mockInput.pressKey("f")
  view.mockInput.pressKey("t", { ctrl: true })
  await screen("Queue · Reply to")
  await view.mockInput.typeText("later")
  view.mockInput.pressEnter()
  await screen("Reply queued.")
  view.mockInput.pressKey("f")
  await screen("Queue · Reply to")
  view.mockInput.pressKey("t", { ctrl: true })
  await screen("Steer · Reply to")
  await view.mockInput.typeText("now")
  view.mockInput.pressEnter()
  const frame = await screen("Reply sent.")
  expect(frame).not.toContain("Reply queued.")
})

test("an idle reply is simply sent", async () => {
  const { view, screen } = await dashboard({ "POST /api/session/ses_main/prompt": accepted })
  await screen("main task")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("hello")
  view.mockInput.pressEnter()
  const frame = await screen("Reply sent.")
  expect(frame).not.toContain("next step")
})

test("the queue dock says its discard needs two presses, and editing says it left the queue", async () => {
  let inputs = [queued("msg_q")]
  const { view, screen } = await dashboard({
    ...running,
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_q/cancel": () => {
      inputs = []
      return { data: true }
    },
  })
  await screen("u 1 queued")
  view.mockInput.pressKey("u")
  const dock = await screen("Ctrl+D twice discard")
  expect(dock).not.toContain("Ctrl+D discard ·")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Reply to main task")
  const frame = await screen("out of the queue")
  expect(frame).toContain("Ctrl+T")
})

test("a message draft is only announced when there is one", async () => {
  const { view, screen } = await dashboard({})
  await screen("main task")
  view.mockInput.pressKey("f")
  await screen("Typing")
  view.mockInput.pressEscape()
  for (let attempt = 0; attempt < 100 && view.captureCharFrame().includes("Typing"); attempt++) {
    await view.renderOnce()
    await Bun.sleep(10)
  }
  expect(view.captureCharFrame()).not.toContain("Typing")
  expect(view.captureCharFrame()).not.toContain("Message draft kept")
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("half a thought")
  view.mockInput.pressEscape()
  await screen("Message draft kept")
})
