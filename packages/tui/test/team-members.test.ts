import { expect, test } from "bun:test"
import { until } from "./support"
import { mates, open, world, type World } from "./team-fixture"

const agents = () => ({
  location: { directory: "/srv/main" },
  data: [
    {
      id: "build",
      mode: "primary",
      hidden: false,
      description: "Builds things",
      request: { headers: {}, body: {} },
      permissions: [],
    },
    { id: "plan", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] },
  ],
})

const catalog = {
  all: [
    {
      id: "claude-code",
      name: "Claude Code (local)",
      models: { opus: { id: "opus", providerID: "claude-code", name: "Claude Opus (latest)" } },
    },
  ],
  connected: ["claude-code"],
  default: {},
}

/** The server applies an edit to one teammate and answers with it. */
function edit(w: World, id: string, change: Record<string, unknown>) {
  const index = w.state.teammates.findIndex((item) => item.id === id)
  w.state.teammates[index] = { ...w.state.teammates[index], ...change }
  return w.state.teammates[index]
}

async function members(w: World) {
  const app = await open(w.routes, 120, 44)
  await app.screen("Done")
  app.view.mockInput.pressKey("M", { shift: true })
  await app.screen("2 in this room")
  return app
}

test("M lists one row per teammate with status, active tasks and duties", async () => {
  const w = world()
  w.state.duties = [{ loopID: "loop_1", teammateID: "tm_moss" }]
  const { screen } = await members(w)
  const frame = await screen("@moss")
  expect(frame).toContain("@moss  Morgan · Engineer · active · 1 active tasks · 1 duties")
  expect(frame).toContain("@rae  Rachel · Engineer · paused · 0 active tasks · 0 duties")
  expect(frame).toContain("Enter menu · a add")
})

test("a adds a teammate with a multi-line mission, and the body carries only what was typed", async () => {
  const w = world({
    "POST /api/team/teammate": (_, url) => {
      const body = w.sent("POST", url.pathname).at(-1)!.body
      const created = {
        ...mates[0],
        id: "tm_zed",
        handle: body.handle,
        name: body.name,
        role: body.role,
        mission: body.mission,
      }
      w.state.teammates.push(created)
      return created
    },
  })
  const { view, screen } = await members(w)
  view.mockInput.pressKey("a")
  await screen("New teammate")
  await view.mockInput.typeText("Zed")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("@zed")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("Reviewer")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("Review diffs.")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("Be brief.")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/teammate").length === 1)
  expect(w.sent("POST", "/api/team/teammate")[0]!.body).toEqual({
    roomID: "trm_team",
    name: "Zed",
    handle: "zed",
    role: "Reviewer",
    mission: "Review diffs.\nBe brief.",
  })
  await screen("@zed  Zed")
})

test("a bad handle is refused locally, and the server's refusal is shown", async () => {
  const w = world({
    "POST /api/team/teammate": () =>
      Response.json({ _tag: "ConflictError", message: "Handle @zed is taken" }, { status: 409 }),
  })
  const { view, screen } = await members(w)
  view.mockInput.pressKey("a")
  await screen("New teammate")
  await view.mockInput.typeText("Zed")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("1zed")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("Triage.")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("The handle needs letters")
  expect(w.sent("POST", "/api/team/teammate")).toHaveLength(0)
  // The refusal put the cursor in the Handle field, so the corrected text goes straight there.
  view.mockInput.pressKey("a", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Zed")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Handle @zed is taken")
  expect(w.sent("POST", "/api/team/teammate")[0]!.body.handle).toBe("zed")
})

test("a teammate needs a mission before anything is sent", async () => {
  const w = world()
  const { view, screen } = await members(w)
  view.mockInput.pressKey("a")
  await screen("New teammate")
  await view.mockInput.typeText("Zed")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("zed")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Enter a mission.")
  expect(w.sent("POST", "/api/team/teammate")).toHaveLength(0)
  // The refusal focused Mission, so typing lands there and clears the message.
  await view.mockInput.typeText("Triage.")
  await screen("Triage.")
  expect((await screen("Mission")).includes("Enter a mission.")).toBe(false)
})

test("Enter opens a teammate's menu; Edit sends the changed fields and resets an agent that was cleared", async () => {
  const w = world({
    "PATCH /api/team/teammate/tm_moss": () => edit(w, "tm_moss", { role: "Lead" }),
    "GET /api/agent": agents,
  })
  w.state.teammates[0] = {
    ...mates[0],
    mission: "Review.",
    agent: "plan",
    model: { providerID: "claude-code", id: "opus" },
  }
  const { view, screen } = await members(w)
  view.mockInput.pressEnter()
  const menu = await screen("Open latest task session")
  for (const row of ["Edit", "Pause", "Stop work", "Duties"]) expect(menu).toContain(row)
  view.mockInput.pressEnter()
  const form = await screen("Edit")
  expect(form).toContain("claude-code/opus")
  expect(form).toContain("plan")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("a", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("Lead")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("a", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("PATCH", "/api/team/teammate/tm_moss").length === 1)
  const body = w.sent("PATCH", "/api/team/teammate/tm_moss")[0]!.body
  expect(body.name).toBe("Morgan")
  expect(body.role).toBe("Lead")
  expect(body.resetAgent).toBe(true)
  expect(body.agent).toBeUndefined()
  expect(body.model).toEqual({ providerID: "claude-code", id: "opus" })
  expect(body.resetModel).toBeUndefined()
})

test("F3 chooses an agent from the server's list and Ctrl+L a model, without leaving the form's text", async () => {
  const w = world({
    "GET /api/agent": agents,
    "GET /provider": () => catalog,
    "POST /api/team/teammate": () => ({ ...mates[0], id: "tm_zed", handle: "zed", name: "Zed" }),
  })
  const { view, screen } = await members(w)
  view.mockInput.pressKey("a")
  await screen("New teammate")
  await view.mockInput.typeText("Zed")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("zed")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("Triage.")
  view.mockInput.pressKey("F3")
  await screen("Builds things")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const form = await screen("New teammate")
  expect(form).toContain("Zed")
  expect(form).toContain("zed")
  view.mockInput.pressKey("l", { ctrl: true })
  await screen("claude-code/opus")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("New teammate")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/teammate").length === 1)
  const body = w.sent("POST", "/api/team/teammate")[0]!.body
  expect(body).toMatchObject({
    name: "Zed",
    handle: "zed",
    agent: "build",
    model: { providerID: "claude-code", id: "opus" },
  })
})

test("Pause sends the status, and a paused teammate offers Resume", async () => {
  const w = world({ "PATCH /api/team/teammate/tm_moss": () => edit(w, "tm_moss", { status: "paused" }) })
  const { view, screen } = await members(w)
  view.mockInput.pressEnter()
  await screen("Open latest task session")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await until(() => w.sent("PATCH", "/api/team/teammate/tm_moss").length === 1)
  expect(w.sent("PATCH", "/api/team/teammate/tm_moss")[0]!.body).toEqual({ status: "paused" })
  await screen("Paused. Running work continues.")
})

test("Stop work needs the typed word and posts to the teammate's stop route", async () => {
  const w = world({ "POST /api/team/teammate/tm_moss/stop": () => new Response(null, { status: 204 }) })
  const { view, screen } = await members(w)
  view.mockInput.pressEnter()
  await screen("Open latest task session")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const dialog = await screen("Confirmation (type stop)")
  expect(dialog).toContain("It does not pause future")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Type stop to confirm.")
  expect(w.sent("POST", "/api/team/teammate/tm_moss/stop")).toHaveLength(0)
  await view.mockInput.typeText("stop")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/teammate/tm_moss/stop").length === 1)
})

test("Open latest task session opens the newest task's session", async () => {
  const w = world()
  const { view, screen } = await members(w)
  view.mockInput.pressEnter()
  await screen("Open latest task session")
  for (let i = 0; i < 4; i++) view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("main says hello")
})

test("an archived room's teammates can be read but not added or edited", async () => {
  const w = world()
  const { view, screen } = await open(w.routes)
  await screen("1 archived hidden")
  view.mockInput.pressKey("A", { shift: true })
  await screen("# retro · archived")
  view.mockInput.pressArrow("up")
  await screen("Archived · read-only")
  view.mockInput.pressKey("M", { shift: true })
  await screen("No teammates yet.")
  view.mockInput.pressKey("a")
  await Bun.sleep(100)
  expect(view.captureCharFrame()).not.toContain("New teammate")
})

test("in the teammate form Enter moves to the next field, keeps its newline in Mission, and sends from the last field", async () => {
  const w = world({
    "POST /api/team/teammate": (_, url) => {
      const body = w.sent("POST", url.pathname).at(-1)!.body
      const created = { ...mates[0], id: "tm_zed", handle: body.handle, name: body.name, role: body.role, mission: body.mission }
      w.state.teammates.push(created)
      return created
    },
  })
  const { view, screen } = await members(w)
  view.mockInput.pressKey("a")
  await screen("New teammate")
  await view.mockInput.typeText("Zed")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("zed")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("Reviewer")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("Review diffs.")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("Be brief.")
  expect(w.sent("POST", "/api/team/teammate")).toHaveLength(0)
  view.mockInput.pressKey("TAB")
  view.mockInput.pressEnter()
  view.mockInput.pressEnter()
  expect(w.sent("POST", "/api/team/teammate")).toHaveLength(0)
  view.mockInput.pressEnter()
  await until(() => w.sent("POST", "/api/team/teammate").length === 1)
  expect(w.sent("POST", "/api/team/teammate")[0]!.body).toEqual({
    roomID: "trm_team",
    name: "Zed",
    handle: "zed",
    role: "Reviewer",
    mission: "Review diffs.\nBe brief.",
  })
})
