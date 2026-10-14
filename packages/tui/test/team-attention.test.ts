import { expect, test } from "bun:test"
import { answer, message, open, room, task, world } from "./team-fixture"
import { permission } from "./agent-fixture"
import { waitForFrame } from "./dashboard-fixture"

const ops = { id: "trm_ops", name: "ops", topic: "Incidents", head: 5 }
const run = {
  id: "run_1",
  roomID: "trm_team",
  status: "needs_input",
  phase: "work",
  taskIDs: ["job_1"],
  time: { created: Date.UTC(2026, 9, 8, 9, 5), updated: Date.UTC(2026, 9, 8, 9, 6) },
}

/** A world where `ses_main` runs and waits on a permission, as the dashboard snapshot sees it. */
function waiting() {
  return {
    "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }),
    "GET /api/session/ses_main/permission": () => ({ data: [permission()] }),
  }
}

/** The sidebar draws one line per room, right of the log. */
function row(frame: string, name: string) {
  return (
    frame
      .split("\n")
      .map((line) => line.split("│")[1] ?? "")
      .find((side) => side.includes(`# ${name}`)) ?? ""
  )
}

test("a room with teammates working is marked in the room list", async () => {
  const w = world()
  w.state.rooms.push(ops)
  w.state.active = ["trm_ops"]
  const { screen } = await open(w.routes)
  const frame = await screen("Done")
  expect(row(frame, "ops")).toContain("working")
  expect(row(frame, "team")).not.toContain("working")
})

test("new messages in another room are counted until you open it and follow", async () => {
  const w = world()
  w.state.rooms.push(ops)
  const { view, screen } = await open(w.routes)
  const first = await screen("Done")
  expect(row(first, "ops")).not.toContain("new")
  w.state.rooms = w.state.rooms.map((item) => (item.id === "trm_ops" ? { ...item, head: 9 } : item))
  view.mockInput.pressKey("r")
  const news = await screen("4 new")
  expect(row(news, "ops")).toContain("4 new")
  view.mockInput.pressArrow("down")
  await screen("No messages yet.")
  await Bun.sleep(300)
  await view.renderOnce()
  expect(row(view.captureCharFrame(), "ops")).not.toContain("new")
})

test("new messages keep a scrolled reader's position until End follows and clears the mark", async () => {
  const messages = Array.from({ length: 60 }, (_, index) => message(index + 1, `entry ${index + 1}`))
  const { view, screen } = await open({
    "GET /api/team": (_, url) => {
      const current = { ...room, head: messages.at(-1)!.seq }
      return answer(messages.filter((item) => item.seq > Number(url.searchParams.get("after") ?? 0)), {
        room: current,
        rooms: [current],
      })
    },
  })
  await screen("entry 60")
  view.mockInput.pressKey("\x1b[5~")
  const scrolled = await waitForFrame(view, (frame) => /entry \d+/.test(frame) && !frame.includes("entry 60"))
  const first = /entry \d+/.exec(scrolled)?.[0]
  expect(first).toBeDefined()
  messages.push(message(61, "entry 61"))
  view.mockInput.pressKey("r")
  const unread = await screen("1 new")
  expect(/entry \d+/.exec(unread)?.[0]).toBe(first)
  expect(unread).not.toContain("entry 61")
  view.mockInput.pressKey("END")
  await screen("entry 61")
  view.mockInput.pressKey("r")
  await waitForFrame(view, (frame) => frame.includes("entry 61") && !row(frame, "team").includes("new"))
})

test("a factory run that needs input is waiting on you in the context line and the room row", async () => {
  const w = world(waiting())
  w.state.runs = [run]
  const { screen } = await open(w.routes)
  const frame = await screen("waiting on you · t")
  expect(frame).toContain("1 waiting on you · t")
  expect(row(frame, "team")).toContain("1 waiting")
})

test("a task whose session needs input is waiting on you and leads the task list", async () => {
  const w = world()
  const other = task("running", {
    id: "job_2",
    sessionID: "ses_other",
    time: { created: 9, updated: 9 },
  })
  w.state.tasks = [task("running"), other]
  const { view, screen } = await open({ ...w.routes, ...waiting() })
  const frame = await screen("1 waiting on you · t")
  expect(frame).toContain("1 waiting on you · t")
  view.mockInput.pressKey("t")
  const picker = await screen("Tasks the room")
  const lines = picker.split("\n")
  const marked = lines.findIndex((line) => line.includes("waiting on you ·") && line.includes("@moss"))
  expect(marked).toBeGreaterThanOrEqual(0)
  const unmarked = lines.findIndex((line, index) => index !== marked && line.includes("running · @moss"))
  expect(unmarked).toBeGreaterThan(marked)
})
