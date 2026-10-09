import { expect, test } from "bun:test"
import { pathTail, plural, roomContext } from "../src/team/format"
import type { TeamView } from "../src/team/types"
import { until } from "./support"
import { open, room, teammate, world } from "./team-fixture"

type Opened = Awaited<ReturnType<typeof open>>

async function clickText(app: Opened, text: string) {
  await app.view.renderOnce()
  const lines = app.view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  await app.view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
}

test("plurals: one duty, two duties, one teammate in the room context", () => {
  expect(plural(1, "duty", "duties")).toBe("1 duty")
  expect(plural(0, "duty", "duties")).toBe("0 duties")
  expect(plural(2, "teammate")).toBe("2 teammates")
  expect(roomContext({ room, teammates: [teammate("moss", "Morgan")], factoryRuns: [] } as unknown as TeamView)).toBe(
    "Ship it · 1 teammate",
  )
})

test("a long path keeps its end, cut at a folder", () => {
  expect(pathTail("/run/user/1000/turen/data/forge", 14)).toBe("…/data/forge")
  expect(pathTail("/srv/main", 30)).toBe("/srv/main")
})

test("Ctrl+P on the Team tab lists the Team commands before the session commands", async () => {
  const w = world()
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("p", { ctrl: true })
  const frame = await screen("Post to room")
  expect(frame.indexOf("Post to room")).toBeLessThan(frame.indexOf("Switch session"))
})

test("the member row drops its role and counts, not half a word, at 80 columns", async () => {
  const w = world()
  w.state.teammates = [{ ...teammate("moss", "Morgan Featherstone"), role: "Principal reliability engineer" }]
  w.state.duties = [{ loopID: "loop_1", teammateID: "tm_moss" }]
  const { view, screen } = await open(w.routes, 80, 30)
  await screen("Done")
  view.mockInput.pressKey("m", { shift: true })
  const frame = await screen("1 teammate in this room")
  const row = frame.split("\n").find((line) => line.includes("@moss"))!
  expect(row).toContain("Morgan Featherstone")
  expect(row).not.toContain("…")
})

test("the room menu describes Edit name and topic in words", async () => {
  const w = world()
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("d")
  const menu = await screen("Edit name and topic")
  expect(menu).toContain("Rename the room or change its topic")
})

test("the post editor's hint fits one line at 80 columns and the action row steps aside", async () => {
  const w = world()
  const { view, screen } = await open(w.routes, 80, 24)
  const before = await screen("A Archived")
  expect(before).toContain("t Tasks")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("hello @moss ")
  await screen("Enter post · Shift+Enter newline · @ mention · Esc")
  for (let i = 0; i < 50 && view.captureCharFrame().includes("A Archived"); i++) {
    await Bun.sleep(20)
    await view.renderOnce()
  }
  const frame = view.captureCharFrame()
  expect(frame.split("\n").filter((line) => line.trim().endsWith("Tasks"))).toEqual([])
})

test("the factory panel gives a wide screen to the detail and leads its runs with the run ID", async () => {
  const w = world()
  w.state.rooms = [
    {
      ...room,
      factory: {
        revision: 1,
        config: {
          outcome: "Ship",
          parameters: {},
          constraints: "",
          acceptanceCriteria: "Done",
          directory: "/very/long/folder/that/goes/on/and/on/and/on/and/on/data/forge",
          coordinatorTeammateID: "tm_moss",
          teammateIDs: ["tm_moss"],
        },
      },
    },
  ]
  w.state.runs = [
    {
      id: "run_polish0001",
      roomID: "trm_team",
      status: "succeeded",
      phase: "done",
      taskIDs: [],
      time: { created: 1, updated: 2 },
    },
  ]
  const { view, screen } = await open(w.routes, 160, 44)
  await screen("Done")
  view.mockInput.pressKey("f", { shift: true })
  const frame = await screen("…lish0001 succeeded")
  expect(frame).toContain("Directory: /very/long/folder/that/goes/on/and/on/and/on/and/on/data/forge")
  view.mockInput.pressKey("ESCAPE")
  await Bun.sleep(150)
  await view.renderOnce()
  const narrow = await open(w.routes, 80, 44)
  await narrow.screen("Done")
  narrow.view.mockInput.pressKey("f", { shift: true })
  const cut = await narrow.screen("Directory: …/")
  expect(cut).toContain("/data/forge")
})

test("a click on a New room or Room entry opens that dialog", async () => {
  const w = world()
  const app = await open(w.routes, 170, 30)
  await app.screen("a New room")
  await clickText(app, "a New room")
  await app.screen("Name")
  app.view.mockInput.pressKey("ESCAPE")
  await Bun.sleep(150)
  await clickText(app, "d Room")
  await app.screen("Delete (archive first)")
})

test("a task session opened from the room offers 4 Team, and a click returns to the room", async () => {
  const w = world()
  const app = await open(w.routes, 120, 30)
  await app.screen("Done")
  app.view.mockInput.pressKey("t")
  await app.screen("queued · @moss")
  app.view.mockInput.pressEnter()
  await app.screen("main says hello")
  app.view.mockInput.pressKey("ESCAPE")
  await Bun.sleep(150)
  await until(() => app.view.captureCharFrame().includes("4 Team"))
  await clickText(app, "4 Team")
  await app.screen("[4 Team]")
})
