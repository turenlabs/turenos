import { expect, test } from "bun:test"
import { parseSchedule, scheduleProblem } from "../src/automations/schedule"
import { fitHeading, fitRow } from "../src/changes/heading"
import { errorText } from "../src/server"
import { dashboard } from "./support"

test("tagged server errors without a message keep their kind", () => {
  expect(errorText({ _tag: "SwarmRoomNotFoundError", resource: "secret-token" })).toBe("Swarm room not found.")
  expect(errorText({ _tag: "not a tag; drop table" })).toBe("Request failed. Check the server connection.")
})

test("schedules reject bad cron fields and intervals under a minute with a friendly reason", () => {
  expect(parseSchedule("every 1m")).toEqual({ intervalSeconds: 60 })
  expect(parseSchedule("*/5 * * * mon-fri")).toMatchObject({ cronExpression: "*/5 * * * mon-fri" })
  for (const bad of ["a b c d e", "61 * * * *", "0 9 * * 8", "* * 0 * *", "*/0 * * * *", "every 0m", "30s"])
    expect(parseSchedule(bad)).toBeUndefined()
  expect(scheduleProblem("every 0m")).toBe("The shortest interval is every 1m.")
  expect(scheduleProblem("a b c d e")).toContain("five fields")
  expect(scheduleProblem("sometimes")).toContain("every 30m")
})

test("narrow headings and rows cut the path from the left and keep the counts", () => {
  const heading = fitHeading(
    60,
    "Uncommitted changes · 4 files +125 -1 · ",
    "/run/user/1000/sandbox/panels/project",
    "",
    "start",
  )
  expect(heading.length).toBeLessThanOrEqual(60)
  expect(heading).toStartWith("Uncommitted changes · 4 files +125 -1 · …")
  expect(heading).toEndWith("project")
  const row = fitRow(60, "A ", "src/deep/very/long/path/a.ts", "  +1 -0")
  expect(row).toEndWith("a.ts  +1 -0")
  expect(row.length).toBeLessThanOrEqual(24 - 4)
})

test("the swarm room says it does not exist yet, and a post refreshes it", async () => {
  let room = false
  const entry = {
    id: "ent_1",
    roomID: "room_1",
    seq: 1,
    actor: { type: "human", memberID: "mem_1", name: "you" },
    kind: "message",
    text: "hello room",
    baseRevision: 0,
    timeCreated: 1,
  }
  const app = await dashboard({
    "GET /api/session/ses_main/room": () =>
      room
        ? {
            data: {
              room: {
                id: "room_1",
                rootSessionID: "ses_main",
                objective: "Ship it",
                budget: 1,
                explicitBudget: false,
                head: 1,
                status: "open",
                timeCreated: 1,
                timeUpdated: 1,
              },
              members: [],
              lanes: [],
            },
          }
        : Response.json({ _tag: "SwarmRoomNotFoundError", resource: "ses_main" }, { status: 404 }),
    "GET /api/session/ses_main/room/entries": () => ({ data: { entries: room ? [entry] : [], head: room ? 1 : 0 } }),
    "POST /api/session/ses_main/room/entries": () => {
      room = true
      return { data: entry }
    },
  })
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  // Enter opens the session with its reply editor; Esc leaves it so w is the room shortcut.
  await app.screen("Esc shortcuts")
  app.view.mockInput.pressEscape()
  await app.screen("Focus: transcript")
  await app.view.mockInput.typeText("w")
  const frame = await app.screen("No swarm room")
  expect(frame).toContain("swarm room yet")
  expect(frame).not.toContain("Request failed")
  app.view.mockInput.pressTab()
  await app.view.mockInput.typeText("hello room")
  app.view.mockInput.pressEnter()
  await app.screen("Open · Ship it")
})

test("a working folder the server cannot read is refused when it is added", async () => {
  const app = await dashboard({
    "GET /api/fs/list": () => new Response("{}", { status: 500 }),
  })
  await app.palette("folders")
  await app.screen("Directory on the server")
  await app.confirm("/missing")
  await app.screen("Folder not found on the server")
  expect(app.server.requests.some((item) => item.method === "PUT")).toBe(false)
})
