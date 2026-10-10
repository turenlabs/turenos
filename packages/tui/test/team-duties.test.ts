import { expect, test } from "bun:test"
import { until } from "./support"
import { loop, open, world, type World } from "./team-fixture"

const other = { ...loop, id: "loop_2", name: "Weekly audit", status: "paused" }

/** The duty list of @moss, which owns loop_1 (listed) and loop_9 (unknown to the automation list). */
async function duties(w: World) {
  w.state.loops = [loop, other]
  w.state.duties = [
    { loopID: "loop_1", teammateID: "tm_moss" },
    { loopID: "loop_9", teammateID: "tm_moss" },
  ]
  const app = await open(w.routes, 120, 44)
  await app.screen("Done")
  app.view.mockInput.pressKey("M", { shift: true })
  await app.screen("2 teammates in this room")
  app.view.mockInput.pressEnter()
  await app.screen("Open latest task session")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("a teammate's duties show each automation's name and status, or the ID when it is unknown", async () => {
  const { screen } = await duties(world())
  const frame = await screen("Nightly check")
  expect(frame).toContain("active · Every 1d")
  expect(frame).toContain("loop_9")
  expect(frame).toContain("Not in the automation list")
  expect(frame).toContain("Enter open in Automations · r run · a assign · n new")
})

test("Enter shows the duty's automation in the Automations tab, selected", async () => {
  const w = world()
  w.state.duties = [{ loopID: "loop_2", teammateID: "tm_moss" }]
  w.state.loops = [loop, other]
  const { view, screen } = await open(w.routes, 120, 44)
  await screen("Done")
  view.mockInput.pressKey("M", { shift: true })
  await screen("2 teammates in this room")
  view.mockInput.pressEnter()
  await screen("Open latest task session")
  for (let i = 0; i < 3; i++) view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Weekly audit")
  view.mockInput.pressEnter()
  const frame = await screen("[3 Auto]")
  expect(frame).toContain("> [paused] Weekly audit")
})

test("r runs the duty's automation now", async () => {
  const w = world({
    "GET /api/loop/loop_1/run": () => [],
    "POST /api/loop/loop_1/run": () => ({ id: "run_1", loopID: "loop_1", status: "running" }),
  })
  const { view, screen } = await duties(w)
  await screen("Nightly check")
  view.mockInput.pressKey("r")
  await until(() => w.sent("POST", "/api/loop/loop_1/run").length === 1)
  await screen('Duty "Nightly check": Started a run.')
})

test("r after a lost answer checks the run history and does not start the duty twice", async () => {
  const runs: unknown[] = []
  const w = world({
    "GET /api/loop/loop_1/run": () => runs,
    "POST /api/loop/loop_1/run": () => {
      runs.push({ id: "run_1", loopID: "loop_1", status: "running", trigger: "manual", time: { created: 1 } })
      return new Response("gateway timeout", { status: 504 })
    },
  })
  const { view, screen } = await duties(w)
  await screen("Nightly check")
  view.mockInput.pressKey("r")
  await screen("HTTP 504")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("1 recent run")
  expect(w.sent("POST", "/api/loop/loop_1/run")).toHaveLength(1)
})

test("a assigns an automation that is not a duty yet", async () => {
  const w = world({
    "POST /api/team/teammate/tm_moss/duty": () => {
      w.state.duties.push({ loopID: "loop_2", teammateID: "tm_moss" })
      return { loopID: "loop_2", teammateID: "tm_moss" }
    },
  })
  const { view, screen } = await duties(w)
  await screen("Nightly check")
  view.mockInput.pressKey("a")
  const picker = await screen("Choose an automation to make a duty.")
  expect(picker).toContain("Weekly audit")
  expect(picker).not.toContain("Nightly check")
  view.mockInput.pressEnter()
  await until(() => w.sent("POST", "/api/team/teammate/tm_moss/duty").length === 1)
  expect(w.sent("POST", "/api/team/teammate/tm_moss/duty")[0]!.body).toEqual({ loopID: "loop_2" })
  await screen('Assigned "Weekly audit" to @moss.')
})

test("n creates a duty from the automation form with the teammate preset", async () => {
  const w = world({
    "POST /api/loop": () => ({ ...loop, id: "loop_3", name: "Triage" }),
  })
  const { view, screen } = await duties(w)
  await screen("Nightly check")
  view.mockInput.pressKey("n")
  const form = await screen("New duty")
  expect(form).toContain("/srv/main")
  await view.mockInput.typeText("Triage")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("triage the queue")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/loop").length === 1)
  expect(w.sent("POST", "/api/loop")[0]!.body).toMatchObject({
    name: "Triage",
    prompt: "triage the queue",
    teammateID: "tm_moss",
    location: { directory: "/srv/main" },
  })
  expect(w.sent("POST", "/api/loop")[0]!.body.factoryRoomID).toBeUndefined()
  await screen("Duties")
})
