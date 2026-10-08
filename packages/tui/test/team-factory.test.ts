import { expect, test } from "bun:test"
import { until } from "./support"
import { loop, open, room, teammate, world, type World } from "./team-fixture"

const old = () => ({ id: "trm_old", name: "retro", topic: "", head: 1, archived: true })
const config = {
  outcome: "Ship the report",
  parameters: { region: "eu" },
  constraints: "No network",
  acceptanceCriteria: "One line each",
  directory: "/srv/main",
  coordinatorTeammateID: "tm_moss",
  teammateIDs: ["tm_moss", "tm_rae"],
}
const configured = { ...room, factory: { revision: 2, config } }
const run = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "run_1",
  roomID: "trm_team",
  status,
  phase: "work",
  taskIDs: ["job_1"],
  time: { created: Date.UTC(2026, 9, 8, 9, 5), updated: Date.UTC(2026, 9, 8, 9, 6) },
  ...extra,
})

async function panel(w: World, key = "F") {
  const app = await open(w.routes, 120, 44)
  await app.screen("Done")
  app.view.mockInput.pressKey(key, { shift: true })
  return app
}

test("an unconfigured room says so and offers settings", async () => {
  const { screen } = await panel(world())
  const frame = await screen("Not configured. s opens settings.")
  expect(frame).toContain("No runs yet.")
  expect(frame).toContain("s settings")
})

test("the summary names the outcome, criteria, coordinator, teammates, directory and revision", async () => {
  const w = world()
  w.state.rooms = [old(), configured]
  const { screen } = await panel(w)
  const frame = await screen("Revision 2")
  for (const text of [
    "Outcome: Ship the report",
    "Acceptance criteria: One line each",
    "Constraints: No network",
    'Parameters: {"region":"eu"}',
    "Coordinator: @moss",
    "Teammates: @moss, @rae",
    "Directory: /srv/main",
  ])
    expect(frame).toContain(text)
})

test("runs show their stage, tasks and result; needs_input says to answer in the task session", async () => {
  const w = world()
  w.state.rooms = [old(), configured]
  w.state.runs = [
    run("needs_input", { result: "Which database should the migration target?" }),
    run("succeeded", { id: "run_0", result: "All done.", time: { created: 1, updated: 2 } }),
  ]
  const { view, screen } = await panel(w)
  const frame = await screen("Needs your answer: open the task session to answer its request.")
  expect(frame).toContain("needs_input · work")
  expect(frame).toContain("Run run_1 · needs_input · phase work")
  expect(frame).toContain("Which database should the migration target?")
  expect(frame).toContain("@moss queued · session ses_main")
  view.mockInput.pressArrow("down")
  const second = await screen("All done.")
  expect(second).toContain("Result:")
})

test("Enter on a run lists its tasks and opens the chosen task's session", async () => {
  const w = world()
  w.state.rooms = [old(), configured]
  w.state.runs = [run("running")]
  const { view, screen } = await panel(w)
  await screen("Run run_1 · running")
  view.mockInput.pressEnter()
  await screen("Enter opens a task's session.")
  view.mockInput.pressEnter()
  await screen("main says hello")
})

test("the panel repaints when a poll brings a finished run", async () => {
  const w = world()
  w.state.rooms = [old(), configured]
  w.state.runs = [run("running")]
  const { screen } = await panel(w)
  await screen("Run run_1 · running")
  w.state.runs = [run("succeeded", { phase: "done", result: "Sandbox check accepted the outputs." })]
  await screen("Sandbox check accepted the outputs.")
})

/** Types into the settings form of an unconfigured room, down to the teammate lists. */
async function fill(app: Awaited<ReturnType<typeof panel>>, parameters?: string) {
  const { view, screen } = app
  await screen("Not configured")
  view.mockInput.pressKey("s")
  await screen("Outcome (required")
  await view.mockInput.typeText("Ship the report")
  view.mockInput.pressKey("TAB")
  if (parameters) {
    view.mockInput.pressKey("BACKSPACE")
    view.mockInput.pressKey("BACKSPACE")
    await view.mockInput.typeText(parameters)
  }
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("One line each")
  view.mockInput.pressKey("TAB")
}

test("settings send the typed config once a coordinator is among the selected teammates", async () => {
  const w = world({
    "PUT /api/team/room/trm_team/factory": () => {
      w.state.rooms = [old(), configured]
      return configured
    },
  })
  const app = await panel(w)
  await fill(app)
  const { view, screen } = app
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey(" ")
  view.mockInput.pressArrow("down")
  view.mockInput.pressKey(" ")
  const marked = await screen("[x] @moss")
  expect(marked).toContain("[x] @rae")
  expect(marked).toContain("(•) @moss")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("PUT", "/api/team/room/trm_team/factory").length === 1)
  expect(w.sent("PUT", "/api/team/room/trm_team/factory")[0]!.body).toEqual({
    outcome: "Ship the report",
    parameters: {},
    constraints: "",
    acceptanceCriteria: "One line each",
    directory: "/srv/main",
    coordinatorTeammateID: "tm_moss",
    teammateIDs: ["tm_moss", "tm_rae"],
  })
  await screen("Factory saved. Saving does not start work: Ctrl+R starts a run.")
})

test("without a selected teammate the desktop's coordinator message refuses the save", async () => {
  const w = world()
  const app = await panel(w)
  await fill(app)
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("Select a coordinator from the selected teammates")
  expect(w.sent("PUT", "/api/team/room/trm_team/factory")).toHaveLength(0)
})

test("bad parameters show an inline error and block the save", async () => {
  const w = world()
  const app = await panel(w)
  await fill(app, '{"a":')
  const frame = await app.screen("JSON")
  expect(frame).toMatch(/JSON|Unexpected|Expected/)
  app.view.mockInput.pressKey("TAB")
  app.view.mockInput.pressKey(" ")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("JSON")
  expect(w.sent("PUT", "/api/team/room/trm_team/factory")).toHaveLength(0)
})

test("parameters must be an object", async () => {
  const app = await panel(world())
  await fill(app, "[1]")
  await app.screen("Parameters must be a JSON object")
})

test("an eleventh teammate cannot be selected", async () => {
  const w = world()
  w.state.teammates = Array.from({ length: 11 }, (_, i) => teammate(`m${i}`, `Mate ${i}`, "active", i + 1))
  const app = await panel(w)
  await fill(app)
  const { view, screen } = app
  view.mockInput.pressKey("TAB")
  for (let i = 0; i < 10; i++) {
    view.mockInput.pressKey(" ")
    view.mockInput.pressArrow("down")
  }
  view.mockInput.pressKey(" ")
  await screen("Select at most 10 teammates")
})

test("Ctrl+R keeps the run ID across a 503, reuses it, and starts a new one after success", async () => {
  let attempts = 0
  const w = world({
    "POST /api/team/room/trm_team/factory/run": () => {
      if (++attempts === 1) return new Response("down", { status: 503 })
      w.state.runs = [run("running")]
      return run("running")
    },
  })
  w.state.rooms = [old(), configured]
  const { view, screen } = await panel(w)
  await screen("Revision 2")
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Request (optional")
  await view.mockInput.typeText("focus on EU")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("HTTP 503")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/room/trm_team/factory/run").length === 2)
  const [first, second] = w.sent("POST", "/api/team/room/trm_team/factory/run")
  expect(first!.body.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(second!.body).toEqual(first!.body)
  expect(first!.body.request).toBe("focus on EU")
  await screen("Run run_1 · running")
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Starts one bounded run")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/room/trm_team/factory/run").length === 3)
  expect(w.sent("POST", "/api/team/room/trm_team/factory/run")[2]!.body.id).not.toBe(first!.body.id)
})

test("a definite refusal clears the pending run ID", async () => {
  let attempts = 0
  const w = world({
    "POST /api/team/room/trm_team/factory/run": () => {
      if (++attempts === 1)
        return Response.json({ _tag: "InvalidRequestError", message: "No active teammates" }, { status: 400 })
      return run("running")
    },
  })
  w.state.rooms = [old(), configured]
  const { view, screen } = await panel(w)
  await screen("Revision 2")
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Request (optional")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("No active teammates")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/room/trm_team/factory/run").length === 2)
  const [first, second] = w.sent("POST", "/api/team/room/trm_team/factory/run")
  expect(second!.body.id).not.toBe(first!.body.id)
})

test("x stops the running run after the typed word", async () => {
  const w = world({
    "POST /api/team/factory-run/run_1/cancel": () => {
      w.state.runs = [run("cancelled")]
      return run("cancelled")
    },
  })
  w.state.rooms = [old(), configured]
  w.state.runs = [run("running")]
  const { view, screen } = await panel(w)
  await screen("Run run_1 · running")
  view.mockInput.pressKey("x")
  await screen("Confirmation (type stop)")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Type stop to confirm.")
  await view.mockInput.typeText("stop")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/factory-run/run_1/cancel").length === 1)
  await screen("cancelled · work")
})

test("t adds a trigger through the automation form with the room and directory set", async () => {
  const w = world({ "POST /api/loop": () => ({ ...loop, id: "loop_5" }) })
  w.state.rooms = [old(), configured]
  const { view, screen } = await panel(w)
  await screen("Revision 2")
  view.mockInput.pressKey("t")
  const form = await screen("Trigger")
  expect(form).toContain("/srv/main")
  await view.mockInput.typeText("Nightly factory")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("run the factory")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/loop").length === 1)
  expect(w.sent("POST", "/api/loop")[0]!.body).toMatchObject({
    name: "Nightly factory",
    factoryRoomID: "trm_team",
    location: { directory: "/srv/main" },
  })
  expect(w.sent("POST", "/api/loop")[0]!.body.teammateID).toBeUndefined()
})

test("an archived room's factory is read-only", async () => {
  const w = world()
  w.state.rooms = [{ ...old(), factory: configured.factory }, room]
  const { view, screen } = await open(w.routes, 120, 44)
  await screen("1 archived hidden")
  view.mockInput.pressKey("A", { shift: true })
  await screen("# retro · archived")
  view.mockInput.pressArrow("up")
  await screen("Archived · read-only")
  view.mockInput.pressKey("F", { shift: true })
  const frame = await screen("Revision 2")
  expect(frame).not.toContain("Ctrl+R run")
  view.mockInput.pressKey("s")
  await screen("Archived rooms are read-only.")
})
