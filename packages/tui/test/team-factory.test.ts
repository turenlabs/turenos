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

async function panel(w: World, key = "F", width = 120, height = 44) {
  const app = await open(w.routes, width, height)
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
  expect(frame).toMatch(/needs_input \d\d:\d\d/)
  expect(frame).toContain("Run run_1 · needs_input · phase work")
  expect(frame).toContain("Which database should the migration target?")
  expect(frame).toContain("@moss · queued · session ses_main · Enter opens")
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
  // The field starts empty (placeholder {}), so typing replaces nothing.
  if (parameters) await view.mockInput.typeText(parameters)
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
  await app.screen("Mark at least one teammate (Space), then choose a coordinator.")
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
  await app.screen('Parameters must be a JSON object, e.g. {"scope":"docs"}')
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
  const stopped = await screen("Run run_1 · cancelled")
  expect(stopped).not.toContain("cancelled · phase")
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

/** The tasks of a finished run, with the messages the server made for each phase. */
function finishedRun(w: World) {
  const phases = [
    ["job_p", "msg_p", "tm_rae", "Factory run run_1 planning task"],
    ["job_w", "msg_w", "tm_moss", "Factory assignment for @moss"],
    ["job_c", "msg_c", "tm_rae", "Factory run run_1 result check"],
  ] as const
  w.state.rooms = [old(), configured]
  w.state.tasks = phases.map(([id, messageID, teammateID], index) => ({
    id,
    roomID: "trm_team",
    messageID,
    teammateID,
    sessionID: `ses_long_session_${index}abcd1234`,
    status: "succeeded",
    time: { created: 2, updated: 2 },
  }))
  w.state.runs = [
    run("succeeded", { phase: "done", taskIDs: ["job_p", "job_w", "job_c"], result: "Checked: everything matches." }),
  ]
  return phases
}

test("a short screen leads with the run's result, collapses the setup, and keeps the key hints", async () => {
  const w = world()
  finishedRun(w)
  w.state.runs = [
    run("failed", { phase: "done", id: "run_20261008_abcdef0123456789", error: "Coordinator returned an invalid FactoryPlan" }),
    run("cancelled", { phase: "done", id: "run_other", time: { created: 1, updated: 2 } }),
  ]
  const { view, screen } = await panel(w, "F", 80, 24)
  const frame = await screen("Error:")
  const lines = frame.split("\n")
  const at = (text: string) => lines.findIndex((line) => line.includes(text))
  expect(at("Run …23456789")).toBeGreaterThan(-1)
  expect(at("failed")).toBeLessThan(at("Error:"))
  expect(at("Error:")).toBeLessThan(at("Outcome Ship the report · coordinator @moss"))
  expect(frame).not.toContain("phase done")
  expect(frame).toContain("s settings")
  expect(frame).toContain("Ctrl+R run")
  expect(frame).toContain("x stop")
  expect(frame).toContain("t trigger")
  // The list column keeps the whole time, and a cancelled run names no phase.
  expect(frame).toMatch(/failed \d\d:\d\d/)
  view.mockInput.pressKey("x")
  const refused = await screen("No factory run is running.")
  expect(refused).toContain("s settings")
  expect(refused).toContain("t trigger")
})

test("a finished run labels each task with its phase and shortens the session ID", async () => {
  const w = world()
  finishedRun(w)
  const { view, screen } = await panel(w)
  const frame = await screen("plan · @rae · done")
  expect(frame).toContain("work · @moss · done")
  expect(frame).toContain("check · @rae · done")
  expect(frame).toContain("session …abcd1234 · Enter opens")
  expect(frame).not.toContain("ses_long_session_0abcd1234")
  view.mockInput.pressEnter()
  const picker = await screen("Enter opens a task's session.")
  expect(picker).toContain("check · @rae · done")
})

test("a refused save puts the cursor in the field it names, and the message goes with the next keystroke", async () => {
  const w = world()
  const app = await panel(w)
  await fill(app, '{"a":')
  const { view, screen } = app
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Ctrl+S retry")
  expect(w.sent("PUT", "/api/team/room/trm_team/factory")).toHaveLength(0)
  // Focus is back in Parameters, so the rest of the JSON lands there and the failure message clears.
  await view.mockInput.typeText("1}")
  const frame = await screen("Tab next field")
  expect(frame).not.toContain("Ctrl+S retry")
  expect(frame).not.toContain("Parameters must be")
  expect(frame).toContain('{"a":1}')
})

test("a save with nothing marked names the fix and focuses the teammate list", async () => {
  const w = world({ "PUT /api/team/room/trm_team/factory": () => configured })
  const app = await panel(w)
  await fill(app)
  const { view, screen } = app
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Mark at least one teammate (Space), then choose a coordinator.")
  view.mockInput.pressKey(" ")
  const marked = await screen("[x] @moss")
  expect(marked).not.toContain("Mark at least one teammate (Space)")
})

test("an empty required field is refused with the cursor in that field", async () => {
  const w = world()
  const app = await panel(w)
  const { view, screen } = app
  await screen("Not configured")
  view.mockInput.pressKey("s")
  await screen("Outcome (required")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("TAB")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Outcome, acceptance criteria, and directory are required")
  await view.mockInput.typeText("Ship it")
  const frame = await screen("Ship it")
  expect(frame).toContain("▶ Outcome")
})

test("the settings form shows one ▶ marker at a time, also on the teammate lists", async () => {
  const w = world()
  const app = await panel(w)
  await fill(app)
  const frame = await app.screen("Teammates (Space marks")
  expect(frame.split("▶").length - 1).toBe(1)
  app.view.mockInput.pressKey("TAB")
  const second = await app.screen("Coordinator (Space chooses")
  expect(second.split("▶").length - 1).toBe(1)
})
